// ---------------------------------------------------------------------------
// Phase 18, Stage 18.5 — the committed node-schema snapshot.
//
// The snapshot is plain data JARVIS reads offline: a reduced copy of n8n's own
// parameter schemas, for exactly the node types a draft may hold. It is
// trusted because it can be checked, and it is checked here:
//
//   - it loads through core's verifier, which takes the hash of its own
//     content and refuses anything that does not match;
//   - it covers exactly the node types in core's draft catalogue — no more,
//     and no fewer;
//   - every value in it matches the pinned manifest: the package, the
//     version, the artifact's hashes, the license;
//   - the notices that the license requires are next to it;
//   - it holds no credential, no secret and no link.
//
// The manifest's hashes are what the generator verified against the upstream
// artifact; this test never fetches anything.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRAFT_NODE_CATALOG, loadNodeSchemaRegistry } from "@jarvis/core";
import { N8N_NODE_SCHEMA_SNAPSHOT } from "../src/node-schema.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const manifest = JSON.parse(readFileSync(`${root}packages/n8n/scripts/node-schema-source.json`, "utf8")) as {
  package: string;
  version: string;
  tarballUrl: string;
  sha512: string;
  sha256: string;
  provenanceUrl: string;
  license: string;
  licenseFileInPackage: string;
  noticeFile: string;
  licenseFile: string;
  snapshotFile: string;
  helperPackages: Record<string, string>;
  nodeTypes: string[];
};

describe("the snapshot loads", () => {
  it("is read whole, or not at all", () => {
    const loaded = loadNodeSchemaRegistry(N8N_NODE_SCHEMA_SNAPSHOT);
    expect(loaded.ok, loaded.ok ? "" : loaded.reason).toBe(true);
  });

  it("is refused when a single byte of it changes", () => {
    const tampered = {
      ...N8N_NODE_SCHEMA_SNAPSHOT,
      nodes: {
        ...N8N_NODE_SCHEMA_SNAPSHOT.nodes,
        "n8n-nodes-base.slack": { ...N8N_NODE_SCHEMA_SNAPSHOT.nodes["n8n-nodes-base.slack"], label: "Somewhere else" },
      },
    };
    const loaded = loadNodeSchemaRegistry(tampered);
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? "" : loaded.reason).toMatch(/content hash/);
  });
});

describe("the snapshot covers exactly what a draft may hold", () => {
  const loaded = loadNodeSchemaRegistry(N8N_NODE_SCHEMA_SNAPSHOT);
  const registry = loaded.ok ? loaded.registry : null;

  it("holds every node type in the draft catalogue, and no other", () => {
    const catalog = Object.keys(DRAFT_NODE_CATALOG).sort();
    expect(Object.keys(N8N_NODE_SCHEMA_SNAPSHOT.nodes).sort()).toEqual(catalog);
    expect(manifest.nodeTypes.slice().sort()).toEqual(catalog);
  });

  it("describes each of them", () => {
    expect(registry).not.toBeNull();
    for (const type of Object.keys(DRAFT_NODE_CATALOG)) {
      const node = registry!.node(type);
      expect(node, type).not.toBeNull();
      expect(node!.label.length).toBeGreaterThan(0);
      expect(node!.versions.length).toBeGreaterThan(0);
      expect(node!.defaultVersion).toBeTruthy();
      expect(node!.versions).toContain(node!.defaultVersion!);
    }
  });

  it("names no node type that is not in the catalogue", () => {
    for (const type of Object.keys(N8N_NODE_SCHEMA_SNAPSHOT.nodes)) {
      expect(DRAFT_NODE_CATALOG[type], type).toBeDefined();
    }
  });

  it("lists nothing as unsupported that the catalogue allows", () => {
    for (const entry of N8N_NODE_SCHEMA_SNAPSHOT.unsupported) {
      expect(DRAFT_NODE_CATALOG[entry.type], entry.type).toBeUndefined();
    }
  });
});

describe("the snapshot matches the pinned source", () => {
  it("names the package, the version and the artifact it was reduced from", () => {
    const source = N8N_NODE_SCHEMA_SNAPSHOT.source;
    expect(source.package).toBe(manifest.package);
    expect(source.version).toBe(manifest.version);
    expect(source.tarballUrl).toBe(manifest.tarballUrl);
    expect(source.sha512).toBe(manifest.sha512);
    expect(source.sha256).toBe(manifest.sha256);
    expect(source.provenanceUrl).toBe(manifest.provenanceUrl);
    expect(source.license).toBe(manifest.license);
  });

  it("carries a hash of its own content, and it is a digest", () => {
    expect(N8N_NODE_SCHEMA_SNAPSHOT.source.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the notices the license requires", () => {
  it("says what the snapshot is and where it came from", () => {
    const notice = readFileSync(`${root}${manifest.noticeFile}`, "utf8");
    expect(notice).toContain(manifest.package);
    expect(notice).toContain(manifest.version);
    expect(notice).toContain(manifest.license);
    // A reduced copy is a modified copy, and says so.
    expect(notice.toLowerCase()).toMatch(/reduc|modif/);
  });

  it("keeps the license text itself next to the data", () => {
    const license = readFileSync(`${root}${manifest.licenseFile}`, "utf8");
    expect(license).toContain("Sustainable Use License");
    expect(license.length).toBeGreaterThan(1000);
  });
});

describe("the snapshot holds nothing it should not", () => {
  const data = JSON.stringify(N8N_NODE_SCHEMA_SNAPSHOT.nodes);

  it("holds no credential and no secret", () => {
    expect(data).not.toMatch(/xox[baprs]-|sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}/);
    expect(data).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });

  it("holds no link and no n8n expression", () => {
    expect(data).not.toMatch(/https?:\/\//);
    expect(data).not.toMatch(/\{\{/);
  });

  it("holds no default value, which would make it change on every build", () => {
    expect(data).not.toMatch(/"default"/);
  });

  it("holds only plain data: names, types, flags, values and bounds", () => {
    const allowed = new Set(["name", "type", "required", "conditional", "displayName", "options", "min", "max", "versions", "defaultVersion", "label", "parameters"]);
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        expect(allowed.has(key), key).toBe(true);
        walk(entry);
      }
    };
    // The node types are the keys of the record; the data is inside them.
    for (const node of Object.values(N8N_NODE_SCHEMA_SNAPSHOT.nodes)) walk(node);
  });
});
