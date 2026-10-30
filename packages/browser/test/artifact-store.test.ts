// ---------------------------------------------------------------------------
// Phase 19.4 — durable, scoped artifact storage (ADR-19-007).
//
// Real files in a real temporary directory: what is under test is the store's
// behaviour on disk — that ids survive a restart and a second instance, that a
// foreign or stale id is simply not found, that quotas hold when writes arrive
// together, and that a crash mid-write leaves nothing a reader could trip on.
// A clock is injected for expiry; file times are set by hand to stand for a
// writer that crashed long ago. Nothing here touches a production path.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JarvisError } from "@jarvis/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DownloadStore, type DownloadStoreConfig } from "../src/download.js";
import { BROWSER_DEFAULT_MAX_DOWNLOAD_BYTES, createBrowserConfig } from "../src/config.js";
import { BrowserRuntime, artifactStoreFor } from "../src/runtime.js";

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const HOUR = 60 * 60 * 1000;

const ALICE = { userId: "alice", organizationId: "org-a" };
const BOB = { userId: "bob", organizationId: "org-a" };
const MALLORY = { userId: "mallory", organizationId: "org-b" };
const ALICE_ELSEWHERE = { userId: "alice", organizationId: "org-b" };

let root: string;
let clock: number;
let logs: Array<{ event: string; fields?: Record<string, string | number | boolean> }>;

function config(overrides: Partial<DownloadStoreConfig> = {}): DownloadStoreConfig {
  return {
    root,
    maxBytes: 1024,
    retentionMs: 24 * HOUR,
    maxBytesPerUser: 1024 * 10,
    maxBytesPerOrganization: 1024 * 50,
    maxArtifactsPerUser: 50,
    maxArtifactsPerOrganization: 200,
    now: () => clock,
    log: (event, fields) => logs.push({ event, fields }),
    ...overrides,
  };
}

const pdf = (sourceOrigin = "https://example.com") => ({ fileName: "report.pdf", bytes: PDF, sourceOrigin });

async function code(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    expect(error).toBeInstanceOf(JarvisError);
    return (error as JarvisError).code;
  }
  throw new Error("expected a refusal");
}

/** Every file under the root, relative, for "what is on disk" assertions. */
async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await filesUnder(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

async function makeOld(path: string): Promise<void> {
  const past = new Date(Date.now() - 24 * HOUR);
  await utimes(path, past, past);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jarvis-artifacts-"));
  clock = Date.UTC(2026, 9, 29, 12, 0, 0);
  logs = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the lifecycle: create, read, delete", () => {
  it("stores, describes, resolves and deletes an artifact in its scope", async () => {
    const store = new DownloadStore(config());
    const stored = await store.storeBytes(ALICE, { ...pdf(), kind: "download" });

    expect(stored).toMatchObject({ byteSize: PDF.length, mimeType: "application/pdf", kind: "download" });
    expect(stored.createdAt).toBe(new Date(clock).toISOString());
    expect(stored.expiresAt).toBe(new Date(clock + 24 * HOUR).toISOString());
    expect(await store.get(ALICE, stored.downloadId)).toEqual(stored);
    expect(await store.readBytes(ALICE, stored.downloadId)).toEqual(PDF);

    expect(await store.delete(ALICE, stored.downloadId)).toBe(true);
    expect(await store.get(ALICE, stored.downloadId)).toBeNull();
    expect(await store.resolveForUpload(ALICE, stored.downloadId)).toBeNull();
    // Deleting again is not an error, and finds nothing.
    expect(await store.delete(ALICE, stored.downloadId)).toBe(false);
  });

  it("returns no path, and stores no remote name or full URL", async () => {
    const store = new DownloadStore(config());
    const stored = await store.storeBytes(ALICE, {
      fileName: "../../etc/passwd.pdf",
      bytes: PDF,
      sourceOrigin: "https://example.com",
    });
    expect(JSON.stringify(stored)).not.toContain(root);
    expect(stored.fileName).toBe(`${stored.downloadId}.pdf`);
    const onDisk = (await filesUnder(root)).join("\n");
    expect(onDisk).not.toContain("passwd");
    expect(onDisk).not.toContain("alice");
    expect(onDisk).not.toContain("org-a");
  });

  it("keeps an origin only when it is one, never a path or a script URL", async () => {
    const store = new DownloadStore(config());
    for (const origin of ["javascript:alert(1)", "https://example.com/private/path?token=x", "x".repeat(400)]) {
      const stored = await store.storeBytes(ALICE, pdf(origin));
      expect(stored.sourceOrigin, origin).toBe("null");
    }
  });
});

describe("durability: a restart and a second instance see the same ids", () => {
  it("an id survives a restart, and its bytes are still the bytes stored", async () => {
    const before = await new DownloadStore(config()).storeBytes(ALICE, pdf());
    const restarted = new DownloadStore(config());
    expect(await restarted.get(ALICE, before.downloadId)).toEqual(before);
    const path = await restarted.resolveForUpload(ALICE, before.downloadId);
    expect(path).not.toBeNull();
    expect(await readFile(path!)).toEqual(PDF);
  });

  it("two instances on one volume share ids, and share one quota", async () => {
    const one = new DownloadStore(config({ maxArtifactsPerUser: 4 }));
    const two = new DownloadStore(config({ maxArtifactsPerUser: 4 }));
    const fromOne = await one.storeBytes(ALICE, pdf());
    expect(await two.get(ALICE, fromOne.downloadId)).toEqual(fromOne);

    // Eight writes split across both instances, at once: exactly three more fit.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_v, i) => (i % 2 === 0 ? one : two).storeBytes(ALICE, pdf()))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results) {
      if (r.status === "rejected") expect((r.reason as JarvisError).code).toBe("ARTIFACT_QUOTA_EXCEEDED");
    }
  });
});

describe("isolation: a foreign, stale or malformed id is not found", () => {
  it("another user, another Organization, or the same user in another Organization finds nothing", async () => {
    const store = new DownloadStore(config());
    const stored = await store.storeBytes(ALICE, pdf());
    for (const other of [BOB, MALLORY, ALICE_ELSEWHERE]) {
      expect(await store.get(other, stored.downloadId)).toBeNull();
      expect(await store.resolveForUpload(other, stored.downloadId)).toBeNull();
      expect(await store.delete(other, stored.downloadId)).toBe(false);
    }
    // And the owner still has it: a refused delete changed nothing.
    expect(await store.get(ALICE, stored.downloadId)).not.toBeNull();
  });

  it.each([
    ["traversal", "../../../etc/passwd"],
    ["an encoded traversal", "%2e%2e%2f%2e%2e"],
    ["a path into the store", "orgs/../tmp/x"],
    ["not a UUID", "not-a-real-id"],
    ["a UUID with a suffix", "11111111-1111-4111-8111-111111111111.json"],
    ["upper case", "11111111-1111-4111-8111-11111111111A"],
    ["empty", ""],
  ])("an id that is %s is not found, and nothing on disk is touched", async (_label, id) => {
    const store = new DownloadStore(config());
    expect(await store.get(ALICE, id)).toBeNull();
    expect(await store.resolveForUpload(ALICE, id)).toBeNull();
    expect(await store.delete(ALICE, id)).toBe(false);
  });

  it.each([
    ["a separator", { userId: "a/b", organizationId: "org-a" }],
    ["a backslash", { userId: "alice", organizationId: "org\\a" }],
    ["dots", { userId: "..", organizationId: "org-a" }],
    ["a space", { userId: "alice", organizationId: "org a" }],
    ["empty", { userId: "", organizationId: "org-a" }],
  ])("a scope with %s is refused", async (_label, scope) => {
    const store = new DownloadStore(config());
    expect(await code(() => store.storeBytes(scope, pdf()))).toBe("DOCUMENT_INVALID");
  });
});

describe("expiry and cleanup", () => {
  it("an expired artifact is not found, does not count against a quota, and the sweep deletes it", async () => {
    const store = new DownloadStore(config({ retentionMs: HOUR, maxArtifactsPerUser: 1 }));
    const old = await store.storeBytes(ALICE, pdf());

    clock += HOUR; // exactly at expiry: gone
    expect(await store.get(ALICE, old.downloadId)).toBeNull();
    expect(await store.resolveForUpload(ALICE, old.downloadId)).toBeNull();
    // The quota is one, and the expired artifact does not hold it.
    const fresh = await store.storeBytes(ALICE, pdf());

    const swept = await store.sweep();
    expect(swept.expired).toBe(1);
    expect((await filesUnder(root)).join("\n")).not.toContain(old.downloadId);
    expect(await store.get(ALICE, fresh.downloadId)).not.toBeNull();
    // Running it again finds nothing more and fails on nothing.
    expect(await store.sweep()).toMatchObject({ expired: 0, failed: 0 });
  });

  it("removes partial writes and unreferenced bytes once old, and leaves a writer's fresh files alone", async () => {
    const store = new DownloadStore(config());
    const kept = await store.storeBytes(ALICE, pdf());
    const orgDir = join(root, "orgs", (await readdir(join(root, "orgs")))[0]!);

    // A crash after the bytes were renamed in but before the record was written.
    const orphan = join(orgDir, "objects", "22222222-2222-4222-8222-222222222222.pdf");
    await writeFile(orphan, PDF);
    // A crash mid-write, and a write still in progress.
    const partial = join(root, "tmp", "dead.part");
    const inProgress = join(root, "tmp", "live.part");
    await writeFile(partial, "x");
    await writeFile(inProgress, "x");
    await makeOld(orphan);
    await makeOld(partial);

    const swept = await store.sweep();
    expect(swept).toMatchObject({ orphans: 1, partial: 1, failed: 0 });
    const left = await filesUnder(root);
    expect(left.some((f) => f.endsWith("dead.part"))).toBe(false);
    expect(left.some((f) => f.endsWith("live.part"))).toBe(true);
    expect(left.some((f) => f.includes("22222222-2222"))).toBe(false);
    expect(await store.resolveForUpload(ALICE, kept.downloadId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The sweep deletes only what this store's contract says is its own and
// broken. A newer release's record, a record it cannot read, the objects of a
// metadata directory it cannot list, and any name it did not write are kept —
// a rollback, or two releases sharing one volume, must not lose artifacts.
// ---------------------------------------------------------------------------

const orgHash = (organizationId: string) => createHash("sha256").update(organizationId).digest("hex").slice(0, 40);
const idN = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function recordOf(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    downloadId: id,
    organizationId: "org-a",
    userId: "alice",
    kind: "download",
    extension: ".pdf",
    byteSize: PDF.length,
    sha256: createHash("sha256").update(PDF).digest("hex"),
    sourceOrigin: "https://example.com",
    createdAt: clock,
    expiresAt: clock + HOUR,
    ...overrides,
  };
}

/** A record file and an object in org-a's directory, both made old unless asked otherwise. */
async function plant(id: string, recordText: string, options: { object?: string; fresh?: boolean } = {}) {
  const orgDir = join(root, "orgs", orgHash("org-a"));
  await mkdir(join(orgDir, "meta"), { recursive: true });
  await mkdir(join(orgDir, "objects"), { recursive: true });
  const meta = join(orgDir, "meta", `${id}.json`);
  const object = join(orgDir, "objects", options.object ?? `${id}.pdf`);
  await writeFile(meta, recordText);
  await writeFile(object, PDF);
  if (!options.fresh) await makeOld(meta);
  await makeOld(object);
  return { meta, object };
}

describe("the sweep removes only what is this store's own and broken", () => {
  it("removes a record that breaks the contract it claims, once old, and then its bytes", async () => {
    const store = new DownloadStore(config());
    const live = await store.storeBytes(ALICE, pdf());
    const broken: Array<[string, string]> = [
      [idN(1), "{not json"],
      [idN(2), "[]"],
      [idN(3), "null"],
      [idN(4), JSON.stringify(recordOf(idN(99)))], // names another id than its file
      [idN(5), JSON.stringify(recordOf(idN(5), { version: 0 }))],
      [idN(6), JSON.stringify(recordOf(idN(6), { version: "2" }))],
      [idN(7), JSON.stringify(recordOf(idN(7), { sha256: "nope" }))], // a kind and format it knows, a field it does not
      [idN(8), JSON.stringify(recordOf(idN(8), { kind: "video", sha256: "nope" }))], // an unknown kind excuses nothing else
      [idN(10), JSON.stringify(recordOf(idN(10), { extension: "../x" }))],
      [idN(11), JSON.stringify(recordOf(idN(11), { kind: "../x" }))],
    ];
    const planted = await Promise.all(broken.map(([id, text]) => plant(id, text)));
    // A writer may still be finishing this one: kept, with its bytes.
    const young = await plant(idN(50), "{still being written", { fresh: true });

    const swept = await store.sweep();
    expect(swept).toMatchObject({ corrupt: broken.length, orphans: broken.length, preserved: 0, failed: 0 });
    for (const { meta, object } of planted) {
      expect(await lstat(meta).catch(() => null)).toBeNull();
      expect(await lstat(object).catch(() => null)).toBeNull();
    }
    expect(await readFile(young.meta, "utf8")).toBe("{still being written");
    expect(await readFile(young.object)).toEqual(PDF);
    expect(await store.resolveForUpload(ALICE, live.downloadId)).not.toBeNull();
  });

  it("keeps a newer release's records and their bytes through every sweep, and never serves them", async () => {
    const store = new DownloadStore(config());
    await store.sweep();
    const future = [
      // A newer version, whatever it holds.
      { id: idN(1), text: JSON.stringify({ version: 2, downloadId: idN(1), owner: { user: "alice" }, blob: "x" }) },
      // This version, with a kind a later release added — already past its expiry.
      { id: idN(2), text: JSON.stringify(recordOf(idN(2), { kind: "video", expiresAt: clock - HOUR })) },
      // This version, with a format a later release added.
      { id: idN(3), text: JSON.stringify(recordOf(idN(3), { extension: ".xlsx" })), object: `${idN(3)}.xlsx` },
    ];
    const planted = await Promise.all(future.map((f) => plant(f.id, f.text, { object: f.object })));

    for (let run = 0; run < 3; run += 1) {
      expect(await store.sweep()).toMatchObject({ preserved: 3, corrupt: 0, orphans: 0, expired: 0, failed: 0 });
      for (const [i, { meta, object }] of planted.entries()) {
        expect(await readFile(meta, "utf8")).toBe(future[i]!.text);
        expect(await readFile(object)).toEqual(PDF);
      }
    }
    for (const { id } of future) expect(await store.get(ALICE, id)).toBeNull();
    expect(logs).toContainEqual({ event: "artifact_record_unsupported", fields: { downloadId: idN(2) } });
    expect(logs.some((l) => l.event === "artifact_record_invalid")).toBe(false);
  });

  it("leaves every name it did not write, however old", async () => {
    const store = new DownloadStore(config());
    await store.sweep();
    const orgDir = join(root, "orgs", orgHash("org-a"));
    const foreignOrg = join(root, "orgs", "not-an-organization-hash");
    await mkdir(join(orgDir, "meta"), { recursive: true });
    await mkdir(join(orgDir, "objects"), { recursive: true });
    await mkdir(join(foreignOrg, "meta"), { recursive: true });
    const kept = [
      join(orgDir, "meta", "index.json"),
      join(orgDir, "objects", "notes.txt"),
      join(orgDir, "objects", `${idN(1)}.xlsx`), // a format this store never writes, with no record
      join(foreignOrg, "meta", `${idN(2)}.json`),
    ];
    for (const path of kept) {
      await writeFile(path, "{not json");
      await makeOld(path);
    }
    const swept = await store.sweep();
    expect(swept).toMatchObject({ corrupt: 0, orphans: 0, failed: 0 });
    expect(swept.skipped).toBeGreaterThanOrEqual(4);
    for (const path of kept) expect(await readFile(path, "utf8")).toBe("{not json");
  });

  it("keeps the bytes of a record it cannot read, and every object of a metadata directory it cannot list", async () => {
    const store = new DownloadStore(config());
    await store.sweep();
    // A directory where a record should be: not a record it can read.
    const { meta, object } = await plant(idN(1), "{}");
    await rm(meta);
    await mkdir(meta);
    // An Organization whose metadata directory is not a directory at all.
    const other = join(root, "orgs", orgHash("org-z"));
    await mkdir(join(other, "objects"), { recursive: true });
    await writeFile(join(other, "meta"), "not a directory");
    const unlisted = join(other, "objects", `${idN(2)}.pdf`);
    await writeFile(unlisted, PDF);
    await makeOld(unlisted);

    expect(await store.sweep()).toMatchObject({ orphans: 0, corrupt: 0 });
    expect(await readFile(object)).toEqual(PDF);
    expect(await readFile(unlisted)).toEqual(PDF);
  });
});

describe("the sweep never follows a link", () => {
  it("leaves a linked directory, and everything outside the store, untouched", async (ctx) => {
    const outside = await mkdtemp(join(tmpdir(), "jarvis-artifacts-outside-"));
    try {
      const id = idN(9);
      await mkdir(join(outside, "scratch"), { recursive: true });
      await mkdir(join(outside, "org", "meta"), { recursive: true });
      await mkdir(join(outside, "org", "objects"), { recursive: true });
      // Each would be removed if the sweep reached it: an old partial file, an
      // old corrupt record, and old bytes no record names.
      const external: Array<[string, string | Buffer]> = [
        [join(outside, "scratch", "dead.part"), "x"],
        [join(outside, "org", "meta", `${id}.json`), "{corrupt"],
        [join(outside, "org", "objects", `${id}.pdf`), PDF],
      ];
      for (const [path, data] of external) {
        await writeFile(path, data);
        await makeOld(path);
      }

      // The store's layout, with links where its own directories would be. On
      // Windows a junction needs no privilege; elsewhere a directory symlink.
      await writeFile(join(root, ".jarvis-artifact-store"), `${JSON.stringify({ version: 1 })}\n`);
      await mkdir(join(root, "orgs", orgHash("org-b")), { recursive: true });
      const links: Array<[string, string]> = [
        [join(outside, "scratch"), join(root, "tmp")],
        [join(outside, "org"), join(root, "orgs", orgHash("org-a"))],
        [join(outside, "org", "meta"), join(root, "orgs", orgHash("org-b"), "meta")],
        [join(outside, "org", "objects"), join(root, "orgs", orgHash("org-b"), "objects")],
      ];
      const type = process.platform === "win32" ? "junction" : "dir";
      for (const [target, path] of links) {
        const made = await symlink(target, path, type).then(
          () => true,
          () => false
        );
        // Where links cannot be made there is nothing to test; production
        // code refuses them either way.
        if (!made) ctx.skip();
      }

      const store = new DownloadStore(config());
      const first = await store.sweep();
      const second = await store.sweep();

      for (const [path, data] of external) expect(await readFile(path)).toEqual(Buffer.from(data));
      for (const [, path] of links) expect((await lstat(path)).isSymbolicLink()).toBe(true);
      expect(first).toMatchObject({ partial: 0, corrupt: 0, orphans: 0, expired: 0, failed: 0 });
      expect(first.skipped).toBeGreaterThanOrEqual(3);
      expect(second).toEqual(first);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("expires a record whose objects directory became a link, and removes nothing through the link", async (ctx) => {
    const outside = await mkdtemp(join(tmpdir(), "jarvis-artifacts-outside-"));
    try {
      const store = new DownloadStore(config({ retentionMs: HOUR }));
      const stored = await store.storeBytes(ALICE, pdf());
      const orgDir = join(root, "orgs", orgHash("org-a"));
      // Outside the store, a file with exactly the name the expired object has.
      const bystander = join(outside, `${stored.downloadId}.pdf`);
      await writeFile(bystander, PDF);
      await rm(join(orgDir, "objects"), { recursive: true });
      const made = await symlink(outside, join(orgDir, "objects"), process.platform === "win32" ? "junction" : "dir").then(
        () => true,
        () => false
      );
      if (!made) ctx.skip();

      clock += HOUR;
      const swept = await store.sweep();

      expect(await readFile(bystander)).toEqual(PDF);
      expect((await lstat(join(orgDir, "objects"))).isSymbolicLink()).toBe(true);
      // The record still goes: a link the sweep will not follow does not hold expiry up.
      expect(await lstat(join(orgDir, "meta", `${stored.downloadId}.json`)).catch(() => null)).toBeNull();
      expect(swept).toMatchObject({ expired: 1, orphans: 0, failed: 0 });
      expect(swept.skipped).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps the bytes of a record that is a link, as it keeps those of any record it does not read", async (ctx) => {
    const outside = await mkdtemp(join(tmpdir(), "jarvis-artifacts-outside-"));
    try {
      const store = new DownloadStore(config());
      await store.sweep();
      const { meta, object } = await plant(idN(1), JSON.stringify(recordOf(idN(1))));
      await rm(meta);
      const made = await symlink(outside, meta, process.platform === "win32" ? "junction" : "dir").then(
        () => true,
        () => false
      );
      if (!made) ctx.skip();

      const swept = await store.sweep();

      expect(await readFile(object)).toEqual(PDF);
      expect((await lstat(meta)).isSymbolicLink()).toBe(true);
      expect(swept).toMatchObject({ orphans: 0, corrupt: 0, failed: 0 });
      expect(swept.skipped).toBeGreaterThanOrEqual(1);
      expect(await store.get(ALICE, idN(1))).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("quotas hold, one write at a time and all at once", () => {
  it.each([
    ["the per-artifact size", { maxBytes: PDF.length - 1 }, "DOCUMENT_TOO_LARGE"],
    ["the per-user count", { maxArtifactsPerUser: 1 }, "ARTIFACT_QUOTA_EXCEEDED"],
    ["the per-Organization count", { maxArtifactsPerOrganization: 1 }, "ARTIFACT_QUOTA_EXCEEDED"],
    ["the per-user bytes", { maxBytesPerUser: PDF.length + 1 }, "ARTIFACT_QUOTA_EXCEEDED"],
    ["the per-Organization bytes", { maxBytesPerOrganization: PDF.length + 1 }, "ARTIFACT_QUOTA_EXCEEDED"],
  ])("refuses a write over %s", async (_label, overrides, expected) => {
    const store = new DownloadStore(config(overrides));
    if (expected === "ARTIFACT_QUOTA_EXCEEDED") await store.storeBytes(ALICE, pdf());
    expect(await code(() => store.storeBytes(expected === "ARTIFACT_QUOTA_EXCEEDED" && "maxArtifactsPerOrganization" in overrides ? BOB : ALICE, pdf()))).toBe(expected);
  });

  it("a per-user quota is per user: another user in the Organization may still write", async () => {
    const store = new DownloadStore(config({ maxArtifactsPerUser: 1 }));
    await store.storeBytes(ALICE, pdf());
    expect(await code(() => store.storeBytes(ALICE, pdf()))).toBe("ARTIFACT_QUOTA_EXCEEDED");
    await expect(store.storeBytes(BOB, pdf())).resolves.toBeTruthy();
    await expect(store.storeBytes(MALLORY, pdf())).resolves.toBeTruthy();
  });

  it("writes that arrive together cannot exceed the Organization's quota between them", async () => {
    const store = new DownloadStore(config({ maxArtifactsPerOrganization: 5, maxArtifactsPerUser: 100 }));
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_v, i) => store.storeBytes(i % 2 ? ALICE : BOB, i % 3 ? pdf() : { fileName: "s.png", bytes: PNG, sourceOrigin: "https://example.com", kind: "screenshot" as const }))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const objects = (await filesUnder(root)).filter((f) => f.includes("/objects/"));
    expect(objects).toHaveLength(5);
    expect(logs.some((l) => l.event === "artifact_store_refused" && l.fields?.reason === "quota")).toBe(true);
  });

  it.each([
    // A 1 ms stale limit: nearly every waiting writer takes the lock over, as
    // two writers may when a crashed writer's lock goes stale.
    ["every lock taken over", (store: DownloadStore) => store],
    // No lock at all: every writer passes the first check before any commits.
    // Deterministic, so a missing re-count always fails here.
    [
      "no lock at all",
      (store: DownloadStore) =>
        Object.assign(store, { withOrgLock: (_org: string, work: () => Promise<unknown>) => work() }),
    ],
  ])("the quota holds even when the lock does not (%s), two instances at once", async (_label, unlock) => {
    // Only the re-count after the write stands between these writers and the quota.
    const limits = { maxArtifactsPerOrganization: 5, maxArtifactsPerUser: 100, lockStaleMs: 1 };
    const stores = [unlock(new DownloadStore(config(limits))), unlock(new DownloadStore(config(limits)))];
    const scopes = Array.from({ length: 24 }, (_v, i) => (i % 3 ? ALICE : BOB));
    const results = await Promise.allSettled(scopes.map((scope, i) => stores[i % 2]!.storeBytes(scope, pdf())));
    const kept = results.flatMap((r, i) => (r.status === "fulfilled" ? [{ scope: scopes[i]!, id: r.value.downloadId }] : []));
    for (const r of results) {
      if (r.status === "rejected") expect((r.reason as JarvisError).code).toBe("ARTIFACT_QUOTA_EXCEEDED");
    }
    expect(kept.length).toBeLessThanOrEqual(5);
    // Nothing refused is left behind, and everything kept is whole.
    const files = await filesUnder(root);
    expect(files.filter((f) => f.includes("/meta/"))).toHaveLength(kept.length);
    expect(files.filter((f) => f.includes("/objects/"))).toHaveLength(kept.length);
    for (const { scope, id } of kept) expect(await stores[0]!.resolveForUpload(scope, id)).not.toBeNull();
    // A refusal held no phantom space: the Organization fills to exactly five.
    const calm = new DownloadStore(config({ maxArtifactsPerOrganization: 5, maxArtifactsPerUser: 100 }));
    for (let n = kept.length; n < 5; n += 1) await calm.storeBytes(BOB, pdf());
    expect(await code(() => calm.storeBytes(BOB, pdf()))).toBe("ARTIFACT_QUOTA_EXCEEDED");
  });
});

describe("corrupted, missing and tampered artifacts are never served", () => {
  it("a record that is not valid JSON, or names another scope, is not found", async () => {
    const store = new DownloadStore(config());
    const stored = await store.storeBytes(ALICE, pdf());
    const orgDir = join(root, "orgs", (await readdir(join(root, "orgs")))[0]!);
    const meta = join(orgDir, "meta", `${stored.downloadId}.json`);

    await writeFile(meta, "{not json");
    expect(await store.get(ALICE, stored.downloadId)).toBeNull();
    expect(logs).toContainEqual({ event: "artifact_record_invalid", fields: { downloadId: stored.downloadId } });

    const forged = JSON.parse(JSON.stringify({ version: 1, downloadId: stored.downloadId, organizationId: "org-a", userId: "mallory", kind: "download", extension: ".pdf", byteSize: PDF.length, sha256: "0".repeat(64), sourceOrigin: "https://example.com", createdAt: clock, expiresAt: clock + HOUR }));
    await writeFile(meta, JSON.stringify(forged));
    expect(await store.get(ALICE, stored.downloadId)).toBeNull();

    await makeOld(meta);
    expect((await store.sweep()).failed).toBe(0);
  });

  it("bytes that changed, went missing, or became a link are refused", async () => {
    const store = new DownloadStore(config());
    const stored = await store.storeBytes(ALICE, pdf());
    const orgDir = join(root, "orgs", (await readdir(join(root, "orgs")))[0]!);
    const object = join(orgDir, "objects", `${stored.downloadId}.pdf`);

    // Same size, different bytes.
    await writeFile(object, Buffer.from(PDF.map((b, i) => (i === PDF.length - 1 ? b ^ 1 : b))));
    expect(await store.resolveForUpload(ALICE, stored.downloadId)).toBeNull();
    expect(logs.some((l) => l.event === "artifact_integrity_failed")).toBe(true);

    await rm(object);
    expect(await store.resolveForUpload(ALICE, stored.downloadId)).toBeNull();

    // A link in the object's place. Creating one can need privileges on
    // Windows; where it cannot be made, there is nothing to test.
    const target = join(root, "elsewhere.pdf");
    await writeFile(target, PDF);
    const linked = await symlink(target, object).then(() => true, () => false);
    if (linked) expect(await store.resolveForUpload(ALICE, stored.downloadId)).toBeNull();
  });
});

describe("the store's own directory", () => {
  it("refuses a directory that already holds something else", async () => {
    await writeFile(join(root, "unrelated.txt"), "keep me");
    const store = new DownloadStore(config());
    expect(await code(() => store.storeBytes(ALICE, pdf()))).toBe("ARTIFACT_STORE_UNAVAILABLE");
    expect(await readdir(root)).toEqual(["unrelated.txt"]);
  });

  it("marks a directory it initialises, and reuses it", async () => {
    await new DownloadStore(config()).storeBytes(ALICE, pdf());
    expect((await readdir(root)).sort()).toEqual([".jarvis-artifact-store", "orgs", "tmp"]);
    await expect(new DownloadStore(config()).storeBytes(ALICE, pdf())).resolves.toBeTruthy();
  });

  it("answers a filesystem failure with one fixed refusal that names no path", async () => {
    const store = new DownloadStore(config());
    await store.storeBytes(BOB, pdf());
    const orgDir = join(root, "orgs", (await readdir(join(root, "orgs")))[0]!);
    // A file where the store's directory should be: every write now fails below it.
    await rm(join(orgDir, "objects"), { recursive: true });
    await writeFile(join(orgDir, "objects"), "not a directory");
    const error = await store.storeBytes(ALICE, pdf()).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(JarvisError);
    expect((error as JarvisError).code).toBe("ARTIFACT_STORE_UNAVAILABLE");
    expect(JSON.stringify({ message: (error as JarvisError).message, details: (error as JarvisError).details })).not.toContain(root);
    expect(logs).toContainEqual({ event: "artifact_store_unavailable", fields: { stage: "write" } });
    // Nothing half-written is reachable, and the lock was released.
    expect((await readdir(join(orgDir, "meta"))).length).toBe(1);
    expect(await readdir(orgDir)).not.toContain(".lock");
  });

  it("takes over a lock a crashed writer left, and waits out a live one", async () => {
    const store = new DownloadStore(config({ lockTimeoutMs: 150 }));
    await store.storeBytes(ALICE, pdf());
    const lock = join(root, "orgs", (await readdir(join(root, "orgs")))[0]!, ".lock");

    await mkdir(lock);
    expect(await code(() => store.storeBytes(ALICE, pdf()))).toBe("ARTIFACT_STORE_UNAVAILABLE");
    await makeOld(lock);
    await expect(store.storeBytes(ALICE, pdf())).resolves.toBeTruthy();
  });

  it("refuses limits and retention that are not positive whole numbers", () => {
    for (const bad of [{ retentionMs: 0 }, { maxBytes: -1 }, { maxArtifactsPerUser: 1.5 }]) {
      expect(() => new DownloadStore(config(bad))).toThrow(/positive whole numbers/);
    }
  });
});

describe("the runtime: no Organization, no session; no retention, no store", () => {
  const browserConfig = (retention?: number) =>
    createBrowserConfig(
      { chromePath: process.execPath, downloadDir: root, ...(retention ? { artifactRetentionHours: retention } : {}) },
      {} as NodeJS.ProcessEnv
    );

  it("refuses to build a store without a retention policy", () => {
    expect(() => artifactStoreFor(browserConfig())).toThrow(/BROWSER_ARTIFACT_RETENTION_HOURS/);
    expect(() => new BrowserRuntime({ config: browserConfig() })).toThrow(/BROWSER_ARTIFACT_RETENTION_HOURS/);
    expect(() => artifactStoreFor(browserConfig(24))).not.toThrow();
  });

  it("reads an empty variable — what compose passes for an unset `${VAR:-}` — as the default, never as zero", () => {
    const composeEnv = {
      BROWSER_MAX_DOWNLOAD_BYTES: "",
      BROWSER_ARTIFACT_RETENTION_HOURS: "24",
      BROWSER_ARTIFACT_QUOTA_BYTES_PER_USER: "",
      BROWSER_ARTIFACT_QUOTA_BYTES_PER_ORGANIZATION: "",
      BROWSER_ARTIFACT_MAX_COUNT_PER_USER: "",
      BROWSER_ARTIFACT_MAX_COUNT_PER_ORGANIZATION: "",
    } as NodeJS.ProcessEnv;
    const parsed = createBrowserConfig({ chromePath: process.execPath, downloadDir: root }, composeEnv);
    expect(parsed.maxDownloadBytes).toBe(BROWSER_DEFAULT_MAX_DOWNLOAD_BYTES);
    expect(parsed).toMatchObject({
      artifactQuotaBytesPerUser: 100 * 1024 * 1024,
      artifactQuotaBytesPerOrganization: 500 * 1024 * 1024,
      artifactMaxCountPerUser: 200,
      artifactMaxCountPerOrganization: 1_000,
    });
    expect(() => artifactStoreFor(parsed)).not.toThrow();
    // An explicit zero is still a mistake, and still refused.
    expect(() =>
      createBrowserConfig({ chromePath: process.execPath, downloadDir: root }, { ...composeEnv, BROWSER_MAX_DOWNLOAD_BYTES: "0" })
    ).toThrow(/maxDownloadBytes/);
  });

  it("refuses a session without an Organization, before any browser is launched", async () => {
    let launched = 0;
    const runtime = new BrowserRuntime({
      config: browserConfig(24),
      launcher: async () => {
        launched += 1;
        throw new Error("no browser in this test");
      },
    });
    await expect(runtime.withSession("alice", async () => "never")).rejects.toThrow(/requires an Organization/);
    await expect(runtime.withSession("alice", async () => "never", { organizationId: "" })).rejects.toThrow(/requires an Organization/);
    expect(launched).toBe(0);
  });
});

describe("logging", () => {
  it("names events and counts, never contents, paths, names or origins", async () => {
    const store = new DownloadStore(config({ maxArtifactsPerUser: 1 }));
    await store.storeBytes(ALICE, pdf("https://secret-origin.example.com"));
    await store.storeBytes(ALICE, pdf()).catch(() => undefined);
    await store.sweep();
    const text = JSON.stringify(logs);
    expect(text).not.toContain(root);
    expect(text).not.toContain("secret-origin");
    expect(text).not.toContain("alice");
    expect(text).not.toContain("org-a");
    expect(text).not.toContain("%PDF");
  });
});
