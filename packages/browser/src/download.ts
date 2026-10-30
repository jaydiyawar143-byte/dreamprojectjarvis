// ---------------------------------------------------------------------------
// Sprint 7.7 / 7.8 — Download and upload containment.
// Phase 19.4 — durable, scoped artifact storage (ADR-19-007).
//
// Properties, all structural rather than checked-at-the-edges:
//
//   1. The model never learns a filesystem path. Stored files are addressed by
//      an opaque `downloadId` (a UUID); every path is built here, from hashes,
//      and none leaves this module except to Playwright's `setInputFiles`.
//
//   2. Uploads can only send back something this store already holds, for the
//      same user AND Organization. The upload tool takes an id, never a path,
//      so "upload /etc/shadow" has no expressible form.
//
//   3. Scoped by owner and Organization. Every artifact lives under its
//      Organization's directory, named by a hash of the Organization id; a
//      lookup reads only the caller's Organization's directory and then checks
//      the user. An id from another scope is not found — not "forbidden" —
//      so its existence is never confirmed.
//
//   4. Durable. Metadata is a file beside the bytes, not a process-memory map,
//      so a restart — or a second service instance on the same volume — finds
//      every id it issued. Both are written to a temporary file and renamed
//      into place, bytes first, so a crash leaves at most an unreferenced
//      object for the sweep, never a record that points at nothing.
//
//   5. Bounded. Per-artifact size, per-user and per-Organization bytes and
//      counts are checked under the Organization's lock (an atomic `mkdir`,
//      safe across processes sharing the volume), so writes that arrive
//      together cannot exceed a quota between them. Expiry is configuration,
//      not a constant; an expired artifact is not found, and the sweep deletes
//      it.
//
// Filenames are GENERATED, never taken from the server that served the file:
// the extension is derived from the sniffed format and the stem is the id.
// Nothing written here is ever executed or served.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { JarvisError } from "@jarvis/core";

/** Formats a browser session may keep, with the bytes that prove the claim. */
interface StorableFormat {
  extension: string;
  mimeType: string;
  /** Leading bytes every file of this format starts with. Empty means text. */
  magic: readonly number[];
}

const STORABLE_FORMATS: readonly StorableFormat[] = Object.freeze([
  { extension: ".pdf", mimeType: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { extension: ".png", mimeType: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { extension: ".jpg", mimeType: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { extension: ".gif", mimeType: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { extension: ".webp", mimeType: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] },
  {
    extension: ".docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    magic: [0x50, 0x4b, 0x03, 0x04],
  },
  { extension: ".txt", mimeType: "text/plain", magic: [] },
  { extension: ".csv", mimeType: "text/csv", magic: [] },
  { extension: ".md", mimeType: "text/markdown", magic: [] },
  { extension: ".json", mimeType: "application/json", magic: [] },
]);

const FORMAT_BY_EXTENSION: ReadonlyMap<string, StorableFormat> = new Map(
  STORABLE_FORMATS.map((format) => [format.extension, format])
);

/**
 * Extensions refused outright, even if the bytes were to match something else.
 *
 * Belt and braces: the allowlist above already excludes every one of these, so
 * this list exists to make the intent unmissable to a future reader adding a
 * format. Nothing in this package executes a file, and nothing should start.
 */
export const EXECUTABLE_EXTENSIONS: readonly string[] = Object.freeze([
  ".exe", ".dll", ".com", ".scr", ".bat", ".cmd", ".ps1", ".msi", ".vbs",
  ".sh", ".bash", ".zsh", ".jar", ".app", ".dmg", ".deb", ".rpm", ".apk",
]);

/** Who an artifact belongs to: both halves, resolved server-side. */
export interface ArtifactScope {
  userId: string;
  organizationId: string;
}

export type ArtifactKind = "download" | "screenshot";

/** What a caller may know about an artifact. Never a path. */
export interface StoredFile {
  downloadId: string;
  fileName: string;
  byteSize: number;
  mimeType: string;
  sourceOrigin: string;
  kind: ArtifactKind;
  createdAt: string;
  expiresAt: string;
}

export interface StoreBytesInput {
  /** Only its extension is consulted, and only as a hint. */
  fileName: string;
  bytes: Buffer;
  mimeType?: string;
  sourceOrigin: string;
  kind?: ArtifactKind;
}

export interface DownloadStoreConfig {
  /**
   * The store's own directory. It must be empty or already hold this store's
   * marker: pointing it at a directory with other contents is refused.
   */
  root: string;
  /** Largest single artifact. */
  maxBytes: number;
  /** How long an artifact lives. Deployment policy; there is no default. */
  retentionMs: number;
  maxBytesPerUser: number;
  maxBytesPerOrganization: number;
  maxArtifactsPerUser: number;
  maxArtifactsPerOrganization: number;
  /** How long a write waits for its Organization's lock. */
  lockTimeoutMs?: number;
  /** A lock older than this is taken to be left by a crashed writer. */
  lockStaleMs?: number;
  /** Unreferenced and partial files younger than this are left for a writer that may still be working. */
  orphanGraceMs?: number;
  now?: () => number;
  /** Fixed-field lifecycle log. Never contents, paths, names or origins. */
  log?: (event: string, fields?: Record<string, string | number | boolean>) => void;
}

export interface ArtifactSweepResult {
  expired: number;
  orphans: number;
  partial: number;
  corrupt: number;
  /** Records a newer release wrote, with their bytes: kept for that release to judge. */
  preserved: number;
  /** Links and entries outside this store's naming, never followed and never removed. */
  skipped: number;
  failed: number;
}

type StoreErrorCode =
  | "DOCUMENT_TOO_LARGE"
  | "DOCUMENT_UNSUPPORTED_FORMAT"
  | "DOCUMENT_INVALID"
  | "DOCUMENT_EMPTY"
  | "ARTIFACT_QUOTA_EXCEEDED"
  | "ARTIFACT_STORE_UNAVAILABLE";

type QuotaName = "user-count" | "organization-count" | "user-bytes" | "organization-bytes";

function quotaError(quota: QuotaName) {
  return storeError("ARTIFACT_QUOTA_EXCEEDED", "Artifact storage quota reached; older artifacts must expire first", {
    quota,
  });
}

function storeError(code: StoreErrorCode, message: string, details?: Record<string, unknown>) {
  return new JarvisError(code, message, details);
}

function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot).toLowerCase();
}

function startsWithMagic(bytes: Buffer, magic: readonly number[]): boolean {
  if (magic.length === 0) return false;
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/** True when the buffer looks like UTF-8 text rather than something binary. */
function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 4096);
  for (const byte of sample) {
    // NUL and most C0 controls never appear in the text formats we accept.
    if (byte === 0) return false;
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
  }
  return true;
}

/**
 * Decides what a downloaded buffer actually is.
 *
 * The sniffed bytes win over both the declared MIME type and the filename,
 * because both of those come from the remote server. A `.txt` that starts with
 * `%PDF-` is a PDF; a `.pdf` full of plain text is text.
 */
export function detectStorableFormat(
  bytes: Buffer,
  hintedFileName?: string
): StorableFormat | null {
  for (const format of STORABLE_FORMATS) {
    if (startsWithMagic(bytes, format.magic)) return format;
  }

  if (!looksLikeText(bytes)) return null;

  // Text of some kind. Use the hinted extension only to pick between the text
  // formats, and fall back to plain text when it says nothing useful.
  const hinted = hintedFileName ? extensionOf(hintedFileName) : null;
  const textFormat = STORABLE_FORMATS.find(
    (format) => format.magic.length === 0 && format.extension === hinted
  );
  return textFormat ?? STORABLE_FORMATS.find((f) => f.extension === ".txt")!;
}

// ---------------------------------------------------------------------------
// The record on disk
// ---------------------------------------------------------------------------

const RECORD_VERSION = 1;
const MARKER_FILE = ".jarvis-artifact-store";
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A user or Organization id: never a path segment (paths use hashes), and never anything that could look like one. */
const SCOPE_PART = /^[A-Za-z0-9_:@-]{1,200}$/;
const ORIGIN_PATTERN = /^(?:https?:\/\/[A-Za-z0-9.:[\]-]{1,300}|null)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface ArtifactRecord {
  version: number;
  downloadId: string;
  organizationId: string;
  userId: string;
  kind: ArtifactKind;
  extension: string;
  byteSize: number;
  sha256: string;
  sourceOrigin: string;
  createdAt: number;
  expiresAt: number;
}

/** A record read from disk is untrusted until every field checks out. */
function parseRecord(text: string, expectedId: string): ArtifactRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const ok =
    r.version === RECORD_VERSION &&
    r.downloadId === expectedId &&
    typeof r.organizationId === "string" &&
    SCOPE_PART.test(r.organizationId) &&
    typeof r.userId === "string" &&
    SCOPE_PART.test(r.userId) &&
    (r.kind === "download" || r.kind === "screenshot") &&
    typeof r.extension === "string" &&
    FORMAT_BY_EXTENSION.has(r.extension) &&
    Number.isSafeInteger(r.byteSize) &&
    (r.byteSize as number) > 0 &&
    typeof r.sha256 === "string" &&
    SHA256_PATTERN.test(r.sha256) &&
    typeof r.sourceOrigin === "string" &&
    ORIGIN_PATTERN.test(r.sourceOrigin) &&
    Number.isSafeInteger(r.createdAt) &&
    Number.isSafeInteger(r.expiresAt);
  return ok ? (r as unknown as ArtifactRecord) : null;
}

const KIND_SHAPE = /^[a-z][a-z0-9-]{0,31}$/;
const EXTENSION_SHAPE = /^\.[a-z0-9]{1,16}$/;
const ORG_DIR_PATTERN = /^[0-9a-f]{40}$/;

type RecordState = { state: "valid"; record: ArtifactRecord } | { state: "unsupported" } | { state: "corrupt" };

/**
 * What a record's text is, for the sweep and the log. Corrupt only when it
 * breaks the contract it claims: not JSON, not this file's id, no version, or
 * a field of this version that is wrong. A record of a NEWER version, or of
 * this version with a kind or a format a later release added (every other
 * field intact), is that release's to judge: never served here, never deleted.
 */
function classifyRecord(text: string, expectedId: string): RecordState {
  const record = parseRecord(text, expectedId);
  if (record) return { state: "valid", record };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "corrupt" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { state: "corrupt" };
  const r = value as Record<string, unknown>;
  if (r.downloadId !== expectedId || !Number.isSafeInteger(r.version) || (r.version as number) < 1) {
    return { state: "corrupt" };
  }
  if ((r.version as number) > RECORD_VERSION) return { state: "unsupported" };

  const knownKind = r.kind === "download" || r.kind === "screenshot";
  const knownFormat = typeof r.extension === "string" && FORMAT_BY_EXTENSION.has(r.extension);
  // A kind and a format this release knows, and still invalid: corrupt.
  if (knownKind && knownFormat) return { state: "corrupt" };
  const kindShaped = knownKind || (typeof r.kind === "string" && KIND_SHAPE.test(r.kind));
  const formatShaped = knownFormat || (typeof r.extension === "string" && EXTENSION_SHAPE.test(r.extension));
  if (!kindShaped || !formatShaped) return { state: "corrupt" };
  // Every other field must still hold exactly as this version requires.
  const rest = parseRecord(JSON.stringify({ ...r, kind: "download", extension: ".pdf" }), expectedId);
  return rest ? { state: "unsupported" } : { state: "corrupt" };
}

function toStoredFile(record: ArtifactRecord): StoredFile {
  return {
    downloadId: record.downloadId,
    fileName: `${record.downloadId}${record.extension}`,
    byteSize: record.byteSize,
    mimeType: FORMAT_BY_EXTENSION.get(record.extension)!.mimeType,
    sourceOrigin: record.sourceOrigin,
    kind: record.kind,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

const hashOf = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Files a browser session downloaded or captured, addressed by opaque id and
 * scoped to one user in one Organization. One store serves every tenant.
 */
export class DownloadStore {
  private readonly root: string;
  private readonly config: Required<Omit<DownloadStoreConfig, "log" | "now">>;
  private readonly now: () => number;
  private readonly log: NonNullable<DownloadStoreConfig["log"]>;
  private ready: Promise<void> | null = null;

  constructor(config: DownloadStoreConfig) {
    const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
    if (
      !positive(config.maxBytes) ||
      !positive(config.retentionMs) ||
      !positive(config.maxBytesPerUser) ||
      !positive(config.maxBytesPerOrganization) ||
      !positive(config.maxArtifactsPerUser) ||
      !positive(config.maxArtifactsPerOrganization)
    ) {
      throw storeError("DOCUMENT_INVALID", "Artifact store limits and retention must be positive whole numbers");
    }
    this.root = resolve(config.root);
    this.config = {
      root: this.root,
      maxBytes: config.maxBytes,
      retentionMs: config.retentionMs,
      maxBytesPerUser: config.maxBytesPerUser,
      maxBytesPerOrganization: config.maxBytesPerOrganization,
      maxArtifactsPerUser: config.maxArtifactsPerUser,
      maxArtifactsPerOrganization: config.maxArtifactsPerOrganization,
      lockTimeoutMs: config.lockTimeoutMs ?? 5_000,
      lockStaleMs: config.lockStaleMs ?? 30_000,
      orphanGraceMs: config.orphanGraceMs ?? 10 * 60_000,
    };
    this.now = config.now ?? Date.now;
    this.log = config.log ?? (() => undefined);
  }

  // -------------------------------------------------------------------------
  // Layout: <root>/orgs/<hash(org)>/{meta,objects,.lock} and <root>/tmp
  // -------------------------------------------------------------------------

  private orgDir(organizationId: string): string {
    return join(this.root, "orgs", hashOf(organizationId));
  }

  private metaPath(organizationId: string, downloadId: string): string {
    return join(this.orgDir(organizationId), "meta", `${downloadId}.json`);
  }

  private objectPath(organizationId: string, downloadId: string, extension: string): string {
    return join(this.orgDir(organizationId), "objects", `${downloadId}${extension}`);
  }

  private tmpPath(suffix: string): string {
    return join(this.root, "tmp", `${randomUUID()}${suffix}`);
  }

  /**
   * Creates the layout once, and refuses a root that already holds something
   * other than this store: pointing it at the wrong directory must not turn
   * that directory into artifact storage.
   */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        let entries: string[] = [];
        try {
          entries = await readdir(this.root);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (entries.length > 0 && !entries.includes(MARKER_FILE)) {
          throw storeError("ARTIFACT_STORE_UNAVAILABLE", "Artifact storage directory is not empty and is not an artifact store");
        }
        await mkdir(join(this.root, "orgs"), { recursive: true, mode: 0o700 });
        await mkdir(join(this.root, "tmp"), { recursive: true, mode: 0o700 });
        if (!entries.includes(MARKER_FILE)) {
          await writeFile(join(this.root, MARKER_FILE), `${JSON.stringify({ version: RECORD_VERSION })}\n`, { mode: 0o600 });
        }
      })().catch((error: unknown) => {
        this.ready = null;
        this.log("artifact_store_unavailable", { stage: "init" });
        throw error instanceof JarvisError
          ? error
          : storeError("ARTIFACT_STORE_UNAVAILABLE", "Artifact storage is not available");
      });
    }
    return this.ready;
  }

  private checkScope(scope: ArtifactScope): void {
    if (!SCOPE_PART.test(scope.userId) || !SCOPE_PART.test(scope.organizationId)) {
      throw storeError("DOCUMENT_INVALID", "Invalid artifact scope");
    }
  }

  // -------------------------------------------------------------------------
  // The Organization's lock: an atomic mkdir, shared by every process on the volume
  // -------------------------------------------------------------------------

  private async withOrgLock<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    const lock = join(this.orgDir(organizationId), ".lock");
    await mkdir(this.orgDir(organizationId), { recursive: true, mode: 0o700 });
    // Wall-clock time throughout: the lock is shared with other processes,
    // whose only common clock is the filesystem's.
    const deadline = Date.now() + this.config.lockTimeoutMs;
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        const errno = (error as NodeJS.ErrnoException).code;
        // Windows answers EPERM, not EEXIST, while another process is still
        // removing the lock: that is contention too, and waits like it.
        if (errno !== "EEXIST" && !(errno === "EPERM" && process.platform === "win32")) throw error;
        // A lock left by a crashed writer is taken over once it is stale.
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > this.config.lockStaleMs) {
          await rmdir(lock).catch(() => undefined);
          continue;
        }
        if (Date.now() > deadline) {
          this.log("artifact_store_refused", { reason: "busy" });
          throw storeError("ARTIFACT_STORE_UNAVAILABLE", "Artifact storage is busy; try again");
        }
        await delay(10 + Math.floor(Math.random() * 20));
      }
    }
    try {
      return await work();
    } finally {
      await rmdir(lock).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Reading records
  // -------------------------------------------------------------------------

  /** The record for `downloadId` in this scope, or null — expired, foreign and malformed alike. */
  private async readRecord(scope: ArtifactScope, downloadId: string): Promise<ArtifactRecord | null> {
    if (typeof downloadId !== "string" || !ID_PATTERN.test(downloadId)) return null;
    this.checkScope(scope);
    await this.ensureReady();
    const path = this.metaPath(scope.organizationId, downloadId);
    let text: string;
    try {
      const info = await lstat(path);
      if (!info.isFile()) return null;
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      this.log("artifact_store_unavailable", { stage: "read" });
      throw storeError("ARTIFACT_STORE_UNAVAILABLE", "Artifact storage is not available");
    }
    const classified = classifyRecord(text, downloadId);
    if (classified.state !== "valid") {
      this.log(classified.state === "unsupported" ? "artifact_record_unsupported" : "artifact_record_invalid", { downloadId });
      return null;
    }
    const { record } = classified;
    if (record.organizationId !== scope.organizationId || record.userId !== scope.userId) return null;
    if (record.expiresAt <= this.now()) return null;
    return record;
  }

  /** Every record of one Organization, valid and unexpired, for the quota check. */
  private async organizationRecords(organizationId: string): Promise<ArtifactRecord[]> {
    const dir = join(this.orgDir(organizationId), "meta");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const now = this.now();
    const records: ArtifactRecord[] = [];
    for (const name of names) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!ID_PATTERN.test(id)) continue;
      const text = await readFile(join(dir, name), "utf8").catch(() => null);
      const record = text === null ? null : parseRecord(text, id);
      if (record && record.organizationId === organizationId && record.expiresAt > now) records.push(record);
    }
    return records;
  }

  // -------------------------------------------------------------------------
  // The lifecycle
  // -------------------------------------------------------------------------

  async storeBytes(scope: ArtifactScope, input: StoreBytesInput): Promise<StoredFile> {
    this.checkScope(scope);
    const { bytes } = input;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw storeError("DOCUMENT_EMPTY", "Downloaded file is empty");
    }
    if (bytes.length > this.config.maxBytes) {
      this.log("artifact_store_refused", { reason: "too-large", byteSize: bytes.length });
      throw storeError("DOCUMENT_TOO_LARGE", "Downloaded file exceeds the size limit", {
        byteSize: bytes.length,
        maxBytes: this.config.maxBytes,
      });
    }

    const hintedExtension = extensionOf(input.fileName);
    if (hintedExtension && EXECUTABLE_EXTENSIONS.includes(hintedExtension)) {
      this.log("artifact_store_refused", { reason: "executable" });
      throw storeError("DOCUMENT_UNSUPPORTED_FORMAT", "Executable downloads are refused", {
        extension: hintedExtension,
      });
    }

    const format = detectStorableFormat(bytes, input.fileName);
    if (!format) {
      this.log("artifact_store_refused", { reason: "format" });
      throw storeError("DOCUMENT_UNSUPPORTED_FORMAT", "Downloaded file is not an accepted format", {
        accepted: STORABLE_FORMATS.map((f) => f.extension),
      });
    }

    let sourceOrigin = typeof input.sourceOrigin === "string" ? input.sourceOrigin : "null";
    if (!ORIGIN_PATTERN.test(sourceOrigin)) sourceOrigin = "null";

    await this.ensureReady();
    const downloadId = randomUUID();
    const createdAt = this.now();
    const record: ArtifactRecord = {
      version: RECORD_VERSION,
      downloadId,
      organizationId: scope.organizationId,
      userId: scope.userId,
      kind: input.kind ?? "download",
      extension: format.extension,
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourceOrigin,
      createdAt,
      expiresAt: createdAt + this.config.retentionMs,
    };

    try {
      return await this.withOrgLock(scope.organizationId, () => this.commitWithinQuota(record, bytes));
    } catch (error) {
      // An unexpected filesystem failure becomes one fixed refusal: an errno's
      // message names the store's path, and nothing about the store leaves it.
      if (error instanceof JarvisError) throw error;
      this.log("artifact_store_unavailable", { stage: "write" });
      throw storeError("ARTIFACT_STORE_UNAVAILABLE", "Artifact storage is not available");
    }
  }

  /** Under the Organization's lock: check the quotas, write, and check them again. */
  private async commitWithinQuota(record: ArtifactRecord, bytes: Buffer): Promise<StoredFile> {
    const { organizationId, userId, downloadId, extension } = record;
    const refusal = this.quotaRefusal(await this.organizationRecords(organizationId), userId, bytes.length);
    if (refusal) {
      this.log("artifact_store_refused", { reason: "quota", quota: refusal });
      throw quotaError(refusal);
    }

    // Bytes first, then the record: a crash between them leaves an object
    // nothing points at (the sweep removes it), never a record without bytes.
    const orgDir = this.orgDir(organizationId);
    await mkdir(join(orgDir, "objects"), { recursive: true, mode: 0o700 });
    await mkdir(join(orgDir, "meta"), { recursive: true, mode: 0o700 });
    await this.writeAtomically(this.objectPath(organizationId, downloadId, extension), bytes);
    await this.writeAtomically(this.metaPath(organizationId, downloadId), Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));

    // The lock serializes writers; this re-count is what makes the quota hold
    // when it does not — a crashed writer's lock taken over by two writers at
    // once, or a holder slower than lockStaleMs. Under a lock that held,
    // nothing was added since the check above, so this cannot trip. Fail
    // closed: over a quota now, this write is undone and refused.
    const late = this.quotaRefusal(await this.organizationRecords(organizationId), userId, 0);
    if (late) {
      await this.removeArtifact(organizationId, downloadId, extension);
      this.log("artifact_store_refused", { reason: "quota", quota: late });
      throw quotaError(late);
    }
    return toStoredFile(record);
  }

  /** The first quota `records` would break with `addedBytes` more in one more artifact (or as they are, for 0). */
  private quotaRefusal(records: ArtifactRecord[], userId: string, addedBytes: number): QuotaName | null {
    const added = addedBytes > 0 ? 1 : 0;
    const mine = records.filter((r) => r.userId === userId);
    const sum = (list: ArtifactRecord[]) => list.reduce((total, r) => total + r.byteSize, 0);
    if (mine.length + added > this.config.maxArtifactsPerUser) return "user-count";
    if (records.length + added > this.config.maxArtifactsPerOrganization) return "organization-count";
    if (sum(mine) + addedBytes > this.config.maxBytesPerUser) return "user-bytes";
    if (sum(records) + addedBytes > this.config.maxBytesPerOrganization) return "organization-bytes";
    return null;
  }

  /** Write to a temporary file in the store, flush it, and rename it into place. */
  private async writeAtomically(destination: string, data: Buffer): Promise<void> {
    const partial = this.tmpPath(".part");
    const handle = await open(partial, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(partial, destination);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Metadata only — never the path. Null for an unknown, foreign or expired id. */
  async get(scope: ArtifactScope, downloadId: string): Promise<StoredFile | null> {
    const record = await this.readRecord(scope, downloadId);
    return record ? toStoredFile(record) : null;
  }

  /**
   * The object's path, for the one caller that needs it: Playwright's
   * `setInputFiles`. Checked on every call: in scope, unexpired, a regular
   * file (not a link), and exactly the bytes that were stored.
   */
  async resolveForUpload(scope: ArtifactScope, downloadId: string): Promise<string | null> {
    const record = await this.readRecord(scope, downloadId);
    if (!record) return null;
    const path = this.objectPath(record.organizationId, record.downloadId, record.extension);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size !== record.byteSize) {
        this.log("artifact_integrity_failed", { downloadId });
        return null;
      }
      const digest = createHash("sha256").update(await readFile(path)).digest("hex");
      if (digest !== record.sha256) {
        this.log("artifact_integrity_failed", { downloadId });
        return null;
      }
    } catch {
      this.log("artifact_integrity_failed", { downloadId });
      return null;
    }
    return isAbsolute(path) ? path : null;
  }

  /** Bytes, for in-process callers only; never a response body (ADR-19-007). */
  async readBytes(scope: ArtifactScope, downloadId: string): Promise<Buffer | null> {
    const path = await this.resolveForUpload(scope, downloadId);
    return path ? readFile(path) : null;
  }

  /** Removes an artifact in this scope. The record goes first, so it is unreachable at once. */
  async delete(scope: ArtifactScope, downloadId: string): Promise<boolean> {
    const record = await this.readRecord(scope, downloadId);
    if (!record) return false;
    try {
      await this.removeArtifact(record.organizationId, record.downloadId, record.extension);
    } catch {
      this.log("artifact_store_unavailable", { stage: "delete" });
      throw storeError("ARTIFACT_STORE_UNAVAILABLE", "Artifact storage is not available");
    }
    return true;
  }

  private async removeArtifact(organizationId: string, downloadId: string, extension: string | null): Promise<void> {
    await rm(this.metaPath(organizationId, downloadId), { force: true });
    if (extension) await rm(this.objectPath(organizationId, downloadId, extension), { force: true });
  }

  /**
   * Deletes only what this store's contract says is its own and broken: what
   * has expired, what was left half-written, and records that break the
   * contract they claim. Safe to run again and alongside writers: a write in
   * progress is younger than the grace period, and a delete of something
   * already gone is not an error.
   *
   * It never follows a link: a linked directory is neither read nor emptied,
   * wherever it sits, and an expired artifact's bytes are removed only from
   * the objects listing it judged — never by a path built from the record.
   * What it cannot judge it keeps — a newer release's record and its bytes, a
   * record it could not read (a link in a record's place among them), every
   * object of a metadata directory it could not list, and any name it did
   * not write.
   */
  async sweep(): Promise<ArtifactSweepResult> {
    await this.ensureReady();
    const result: ArtifactSweepResult = {
      expired: 0,
      orphans: 0,
      partial: 0,
      corrupt: 0,
      preserved: 0,
      skipped: 0,
      failed: 0,
    };
    const now = this.now();
    const graceAgo = Date.now() - this.config.orphanGraceMs;
    const old = (info: Stats) => info.mtimeMs < graceAgo;

    for (const entry of (await this.entriesOf(join(this.root, "tmp"), result)) ?? []) {
      if (old(entry.info)) {
        await rm(entry.path, { force: true, recursive: true }).then(() => (result.partial += 1), () => (result.failed += 1));
      }
    }

    for (const org of (await this.entriesOf(join(this.root, "orgs"), result)) ?? []) {
      if (!org.info.isDirectory() || !ORG_DIR_PATTERN.test(org.name)) {
        result.skipped += 1;
        continue;
      }
      const linkedRecords: string[] = [];
      const records = await this.entriesOf(join(org.path, "meta"), result, linkedRecords);
      // Without the full list of records, no object can be called an orphan.
      if (records === null) continue;
      const referenced = new Set<string>();
      // Ids whose bytes stay whatever happens: a record kept for a newer
      // release, one that could not be read, one a writer may still be finishing.
      const protectedIds = new Set<string>();
      // A link in a record's place is a record this store does not read.
      for (const name of linkedRecords) if (name.endsWith(".json")) protectedIds.add(name.slice(0, -5));
      // Bytes of records expired below, removed from the objects listing.
      const expiredObjects = new Set<string>();
      for (const entry of records) {
        const id = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : "";
        if (!ID_PATTERN.test(id)) {
          result.skipped += 1;
          continue;
        }
        if (!entry.info.isFile()) {
          protectedIds.add(id);
          result.skipped += 1;
          continue;
        }
        let text: string;
        try {
          text = await readFile(entry.path, "utf8");
        } catch {
          // Unreadable now is not proof of corruption.
          protectedIds.add(id);
          result.failed += 1;
          continue;
        }
        const classified = classifyRecord(text, id);
        if (classified.state === "unsupported") {
          protectedIds.add(id);
          result.preserved += 1;
          continue;
        }
        // Broken, or filed under an Organization that is not its own: never
        // served (a read checks both), and removed once a writer could no
        // longer be finishing it. Its bytes, unreferenced, follow as an orphan.
        if (classified.state === "corrupt" || hashOf(classified.record.organizationId) !== org.name) {
          if (old(entry.info)) {
            await rm(entry.path, { force: true }).then(() => (result.corrupt += 1), () => (result.failed += 1));
          } else {
            protectedIds.add(id);
          }
          continue;
        }
        const { record } = classified;
        if (record.expiresAt <= now) {
          // The record first, so the artifact is gone at once; its bytes go
          // below, and only if the objects directory is one the sweep may enter.
          await rm(entry.path, { force: true }).then(
            () => {
              result.expired += 1;
              expiredObjects.add(`${record.downloadId}${record.extension}`);
            },
            () => (result.failed += 1)
          );
          continue;
        }
        referenced.add(`${record.downloadId}${record.extension}`);
      }
      for (const entry of (await this.entriesOf(join(org.path, "objects"), result)) ?? []) {
        const id = entry.name.slice(0, 36);
        // Only `<id><a format this store writes>` is ever this store's object.
        const ours = ID_PATTERN.test(id) && FORMAT_BY_EXTENSION.has(entry.name.slice(36)) && entry.info.isFile();
        if (!ours) {
          result.skipped += 1;
          continue;
        }
        if (expiredObjects.has(entry.name)) {
          await rm(entry.path, { force: true }).catch(() => (result.failed += 1));
          continue;
        }
        if (referenced.has(entry.name) || protectedIds.has(id) || !old(entry.info)) continue;
        await rm(entry.path, { force: true }).then(() => (result.orphans += 1), () => (result.failed += 1));
      }
    }

    this.log("artifact_sweep", { ...result });
    return result;
  }

  /**
   * A directory's entries, each with its own `lstat`, for the sweep. A link is
   * counted as skipped and never returned (its name goes to `links`, when
   * given), so nothing beneath one is read or removed. Null when the directory
   * cannot be judged — a link, not a directory, or unreadable — and empty when
   * it does not exist.
   */
  private async entriesOf(
    dir: string,
    result: ArtifactSweepResult,
    links?: string[]
  ): Promise<Array<{ name: string; path: string; info: Stats }> | null> {
    let own: Stats;
    try {
      own = await lstat(dir);
    } catch (error) {
      return isMissing(error) ? [] : null;
    }
    if (own.isSymbolicLink()) {
      result.skipped += 1;
      return null;
    }
    if (!own.isDirectory()) return null;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      return isMissing(error) ? [] : null;
    }
    const entries: Array<{ name: string; path: string; info: Stats }> = [];
    for (const name of names) {
      const path = join(dir, name);
      const info = await lstat(path).catch(() => null);
      if (info === null) continue;
      if (info.isSymbolicLink()) {
        result.skipped += 1;
        links?.push(name);
        continue;
      }
      entries.push({ name, path, info });
    }
    return entries;
  }
}
