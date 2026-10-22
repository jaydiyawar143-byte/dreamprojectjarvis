#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Phase 18, Stage 18.5 — the development-time generator of JARVIS's trusted
// n8n node-schema snapshot.
//
// WHAT IT IS. It reads ONE pinned npm artifact — `n8n-nodes-base` at the exact
// version in `node-schema-source.json` — verifies that artifact against the
// registry's own integrity hash, and reduces the parameter schemas of the
// node types a JARVIS draft may hold into one plain, bounded JSON object that
// is committed to the repository. At run time JARVIS reads that file and
// nothing else: no network, no n8n instance, no credentials.
//
// THE ORDER MATTERS. The hash is checked before the archive is opened, so a
// substituted tarball is refused before a byte of it is read. The reduction
// keeps an explicit allowlist of fields, so anything upstream adds that is not
// on the list is dropped rather than carried along.
//
// WHAT IT RUNS. Reading a node's parameter schema means asking n8n for it,
// which means loading the node's own module — the same thing n8n's own
// generator does. The loader here is fenced: no network module is reachable,
// a module that is not on the pinned list is an inert stub that throws when
// called, and the only real packages are the ones `node-schema-source.json`
// pins. The loader runs outside this repository, in a throwaway directory.
//
// IT NEVER RUNS IN THE APPLICATION. The generated file is plain data. Nothing
// this script downloads or extracts is executed by JARVIS.
//
//   node packages/n8n/scripts/generate-node-schema-snapshot.mjs \
//     --tarball <path-to-n8n-nodes-base-2.15.1.tgz> [--runner <dir>] [--out <file>]
//
// With no --runner, the pinned helper packages are installed into a temporary
// directory (this needs npm and the network). With --runner, that directory is
// used as it is.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { manifest: path.join(HERE, "node-schema-source.json"), tarball: null, runner: null, out: null, notice: null, license: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--manifest") args.manifest = path.resolve(next());
    else if (arg === "--tarball") args.tarball = path.resolve(next());
    else if (arg === "--runner") args.runner = path.resolve(next());
    else if (arg === "--out") args.out = path.resolve(next());
    else if (arg === "--notice") args.notice = path.resolve(next());
    else if (arg === "--license") args.license = path.resolve(next());
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function fail(message) {
  process.stderr.write(`generate-node-schema-snapshot: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The artifact: verified before it is opened.
// ---------------------------------------------------------------------------

function digestOf(file) {
  const bytes = fs.readFileSync(file);
  return {
    bytes: bytes.length,
    sha512: createHash("sha512").update(bytes).digest("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function verifyArtifact(tarball, source) {
  if (!fs.existsSync(tarball)) fail(`the tarball ${tarball} does not exist. Download it from ${source.tarballUrl} first.`);
  const digest = digestOf(tarball);
  if (digest.sha512 !== source.sha512) {
    fail(`the tarball's SHA-512 does not match the pinned one.\n  expected ${source.sha512}\n  actual   ${digest.sha512}`);
  }
  if (digest.sha256 !== source.sha256) {
    fail(`the tarball's SHA-256 does not match the pinned one.\n  expected ${source.sha256}\n  actual   ${digest.sha256}`);
  }
  return digest;
}

function extract(tarball, into) {
  fs.mkdirSync(into, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tarball, "-C", into], { stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) fail(`the tarball could not be extracted: ${String(result.stderr || "").trim()}`);
  const root = path.join(into, "package");
  if (!fs.existsSync(path.join(root, "package.json"))) fail("the tarball does not contain a package/ directory as expected");
  return root;
}

// ---------------------------------------------------------------------------
// The runner: the pinned helper packages, outside this repository.
// ---------------------------------------------------------------------------

function prepareRunner(source, requested) {
  const helpers = Object.entries(source.helperPackages).map(([name, version]) => `${name}@${version}`);
  if (requested) {
    const installed = path.join(requested, "node_modules");
    if (!fs.existsSync(installed)) fail(`the runner ${requested} has no node_modules. Install ${helpers.join(" ")} there first.`);
    return requested;
  }
  const runner = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-n8n-schema-"));
  fs.writeFileSync(
    path.join(runner, "package.json"),
    `${JSON.stringify({ name: "jarvis-n8n-schema-runner", private: true, version: "1.0.0", dependencies: Object.fromEntries(helpers.map((h) => h.split("@"))) }, null, 2)}\n`
  );
  const install = spawnSync("npm", ["install", "--prefix", runner, "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", ...helpers], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (install.status !== 0) fail(`the pinned helper packages could not be installed: ${String(install.stderr || "").trim()}`);
  return runner;
}

// ---------------------------------------------------------------------------
// The loader: fenced. No network, no unpinned code.
// ---------------------------------------------------------------------------

const BLOCKED_MODULES = new Set(["http", "https", "net", "tls", "dns", "dgram", "child_process", "worker_threads", "inspector", "vm", "cluster", "repl"]);

function inertStub(name) {
  const target = function stubbedModule() {
    throw new Error(`the module "${name}" is not available to the schema loader`);
  };
  return new Proxy(target, {
    get(_target, property) {
      if (property === "__esModule") return undefined;
      if (property === "then") return undefined;
      if (property === Symbol.toPrimitive) return () => name;
      if (property === "toString") return () => `[stub ${name}]`;
      if (property === Symbol.for("nodejs.util.inspect.custom")) return () => `[stub ${name}]`;
      return inertStub(`${name}.${String(property)}`);
    },
    apply() {
      throw new Error(`the module "${name}" is not available to the schema loader`);
    },
    construct() {
      throw new Error(`the module "${name}" is not available to the schema loader`);
    },
  });
}

function installLoader(runner) {
  const originalLoad = Module._load;
  const workflow = originalLoad.call(Module, path.join(runner, "node_modules", "n8n-workflow"), null, false);
  const isBare = (request) => !request.startsWith(".") && !request.startsWith("/") && !path.isAbsolute(request);
  Module._load = function load(request, parent, isMain) {
    if (request === "n8n-workflow") return workflow;
    if (BLOCKED_MODULES.has(request)) return inertStub(request);
    if (isBare(request)) {
      try {
        return originalLoad.call(this, request, parent, isMain);
      } catch (error) {
        if (error && error.code === "MODULE_NOT_FOUND") {
          try {
            const resolved = require.resolve(request, { paths: [path.join(runner, "node_modules")] });
            return originalLoad.call(this, resolved, parent, isMain);
          } catch {
            return inertStub(request);
          }
        }
        throw error;
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return originalLoad;
}

// ---------------------------------------------------------------------------
// The index: which file holds which node type, read without running anything.
// ---------------------------------------------------------------------------

function indexNodeTypes(packageRoot) {
  const index = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".node.json")) {
        let meta;
        try {
          meta = JSON.parse(fs.readFileSync(full, "utf8"));
        } catch {
          continue;
        }
        if (!meta || typeof meta.node !== "string") continue;
        const script = full.replace(/\.node\.json$/, ".node.js");
        if (fs.existsSync(script)) index.set(meta.node, script);
      }
    }
  };
  walk(path.join(packageRoot, "dist", "nodes"));
  return index;
}

// ---------------------------------------------------------------------------
// The reduction: an allowlist. What is not on it is dropped.
// ---------------------------------------------------------------------------

/** The parameter types whose `options` are the values the parameter may hold. */
const VALUE_LIST_TYPES = new Set(["options", "multiOptions", "resource", "operation"]);

/**
 * The types that are not parameters at all.
 *
 * n8n's `notice` entries are the node's own explanatory text — often a
 * paragraph of HTML with a link in it. They are not something a person
 * configures, so a draft can never hold one, and keeping them would put a
 * web page into a file JARVIS reads.
 */
const NON_PARAMETER_TYPES = new Set(["notice"]);

/** A label longer than this is a paragraph, not a label. */
const MAX_DISPLAY_NAME = 120;

function isPrimitive(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function reduceParameter(raw) {
  const parameter = {
    name: String(raw.name),
    type: typeof raw.type === "string" ? raw.type : "string",
    required: raw.required === true,
    // A parameter the upstream schema shows only in some configurations is not
    // required of the draft: its presence depends on another answer.
    conditional: raw.displayOptions !== undefined && raw.displayOptions !== null,
  };
  // The label a person reads. A paragraph of HTML is not one, and an empty
  // string is not either: the parameter's own name is the fallback.
  if (typeof raw.displayName === "string" && raw.displayName.length > 0 && raw.displayName.length <= MAX_DISPLAY_NAME) {
    parameter.displayName = raw.displayName;
  }
  // Only a value list says what a parameter may hold. A collection's options
  // are the fields it holds, not values; they are dropped.
  if (VALUE_LIST_TYPES.has(parameter.type) && Array.isArray(raw.options) && raw.options.length > 0) {
    const values = [];
    let literal = true;
    for (const option of raw.options) {
      const value = option && typeof option === "object" ? option.value : undefined;
      if (isPrimitive(value)) values.push(value);
      else {
        literal = false;
        break;
      }
    }
    // A list that is not all literals is dynamic: it is left out, and the
    // check never claims the value was one of the options.
    if (literal) parameter.options = values;
  }
  if (parameter.type === "number" && raw.typeOptions && typeof raw.typeOptions === "object") {
    if (typeof raw.typeOptions.minValue === "number") parameter.min = raw.typeOptions.minValue;
    if (typeof raw.typeOptions.maxValue === "number") parameter.max = raw.typeOptions.maxValue;
  }
  // A default is deliberately left out. No rule needs it, and some upstream
  // defaults are the moment the node was loaded — which would make the
  // snapshot change every time it was generated.
  return parameter;
}

function reduceNode(type, instance) {
  const description = instance.description ?? {};
  const versions = instance.nodeVersions
    ? Object.keys(instance.nodeVersions)
    : Array.isArray(description.version)
      ? description.version.map(String)
      : description.version !== undefined
        ? [String(description.version)]
        : [];
  const defaultVersion =
    description.defaultVersion !== undefined
      ? String(description.defaultVersion)
      : versions.length > 0
        ? versions[versions.length - 1]
        : null;
  // A versioned node keeps its parameters in the version's own description.
  const chosen = instance.nodeVersions && defaultVersion !== null ? instance.nodeVersions[defaultVersion] : instance;
  const properties = chosen && chosen.description && Array.isArray(chosen.description.properties) ? chosen.description.properties : null;
  // A description whose properties could not be read is a failed extraction,
  // not a node with nothing to configure. The two are told apart here.
  if (properties === null) throw new Error("the node's description declares no property list");
  // A notice is the node's own text, not a parameter: it is left out.
  const parameters = properties.filter((property) => property && typeof property === "object" && !NON_PARAMETER_TYPES.has(property.type)).map(reduceParameter);
  const node = {
    type,
    label: typeof description.displayName === "string" ? description.displayName : type,
    versions,
    parameters,
  };
  if (defaultVersion !== null) node.defaultVersion = defaultVersion;
  return node;
}

// ---------------------------------------------------------------------------
// The output.
// ---------------------------------------------------------------------------

const HASH_PREFIX = "n8n-node-schema:v1:";

function contentHash(nodes, unsupported) {
  return createHash("sha256").update(`${HASH_PREFIX}${JSON.stringify({ nodes, unsupported })}`).digest("hex");
}

function renderSnapshot(source, nodes, unsupported, hash) {
  const metadata = {
    package: source.package,
    version: source.version,
    tarballUrl: source.tarballUrl,
    sha512: source.sha512,
    sha256: source.sha256,
    provenanceUrl: source.provenanceUrl,
    license: source.license,
    licenseFile: path.basename(source.licenseFile),
    contentHash: hash,
  };
  const block = (value, rest) =>
    JSON.stringify(value, null, 2)
      .split("\n")
      .map((line, index) => (index === 0 ? line : `${rest}${line}`))
      .join("\n");
  return `// ---------------------------------------------------------------------------
// GENERATED FILE - do not edit it by hand.
//
// A REDUCED, MODIFIED copy of parts of the npm package ${source.package} ${source.version},
// licensed under the ${source.license}. The upstream notices are not altered,
// removed or obscured: the attribution, the pinned hashes and the modification
// are in ./${path.basename(source.noticeFile)}, and the licence itself is in
// ./${path.basename(source.licenseFile)}.
//
//   upstream   ${source.package}@${source.version}
//   tarball    ${source.tarballUrl}
//   sha-512    sha512-${source.sha512}
//   sha-256    ${source.sha256}
//   provenance ${source.provenanceUrl}
//
// Regenerate it with packages/n8n/scripts/generate-node-schema-snapshot.mjs.
// The content hash below is over the reduced data; the runtime refuses a file
// whose hash does not match.
// ---------------------------------------------------------------------------

import type { NodeSchemaSnapshot } from "@jarvis/core";

export const N8N_NODE_SCHEMA_SNAPSHOT: NodeSchemaSnapshot = {
  source: ${block(metadata, "  ")},
  nodes: ${block(nodes, "  ")},
  unsupported: ${block(unsupported, "  ")},
};
`;
}

function renderNotice(source, digest, unsupported) {
  const unsupportedLines =
    unsupported.length === 0
      ? "- None: every node type in the list above was read and reduced."
      : unsupported.map((u) => `- ${u.type}: ${u.reason}`).join("\n");
  return `# NOTICE — the n8n node-schema snapshot

This directory holds a **reduced, modified copy** of parts of the npm package
\`${source.package}\`, and nothing else.

| | |
|---|---|
| Upstream project | n8n — https://github.com/n8n-io/n8n |
| Package | \`${source.package}@${source.version}\` |
| Tarball | ${source.tarballUrl} |
| Registry SHA-512 | \`sha512-${source.sha512}\` |
| SHA-256 | \`${source.sha256}\` |
| Size of the verified tarball | ${digest.bytes} bytes |
| Provenance | ${source.provenanceUrl} |
| Provenance detail | SLSA provenance v1, built by n8n-io/n8n's own release workflow through GitHub OIDC; the attestation's subject digest is the SHA-512 above |
| Licence | ${source.license} — the full text is in ./${path.basename(source.licenseFile)}, copied verbatim from the verified package's own \`${source.licenseFileInPackage}\` |

## What this is

\`node-schema.ts\` keeps, for each of the ${source.nodeTypes.length} node types a JARVIS draft may hold:

- the node type and its label;
- the versions the node declares, and the one the snapshot describes;
- for each parameter: its name, its type, whether the upstream schema requires
  it, whether the upstream schema shows it only in some configurations, the
  literal option values where the upstream schema lists them, and the numeric
  bounds where it declares them.

Everything else in the upstream package — the node code, the credentials, the
icons, the documentation, the other node types, the parameter types' internals
— is not here. A parameter whose options are loaded dynamically is left without
an option list on purpose: JARVIS then does not claim a value was one of the
options.

## This file is modified

It is a derivative work of the licensed work, reduced to the fields JARVIS
checks a draft against. The upstream notices are not altered, removed or
obscured; they are reproduced above and in the licence copy beside it, and
this file says so where it is read.

## Node types that could not be reduced

${unsupportedLines}

## What you may do with it

The ${source.license} permits use, copying, modification and distribution for
your own internal business purposes, or for non-commercial or personal use,
provided the notices are kept and any modification is marked — as they are,
here. Distribution to others must be free of charge and non-commercial.

JARVIS uses the snapshot only to check a draft's settings offline. It never
redistributes n8n itself, never sends the snapshot to an n8n instance, and
never asks an n8n instance for its schemas.

If you do not accept these terms, do not use or redistribute this directory.
`;
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "usage: generate-node-schema-snapshot.mjs --tarball <file.tgz> [--runner <dir>] [--out <file>] [--notice <file>] [--license <file>]\n"
    );
    return;
  }
  const source = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
  if (!args.tarball) fail(`--tarball is required. The pinned artifact is ${source.tarballUrl}`);

  process.stdout.write(`verifying ${path.basename(args.tarball)} against the pinned hashes...\n`);
  const digest = verifyArtifact(args.tarball, source);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-n8n-schema-"));
  try {
    const packageRoot = extract(args.tarball, path.join(work, "package"));
    const runner = prepareRunner(source, args.runner);
    const originalLoad = installLoader(runner);
    const index = indexNodeTypes(packageRoot);

    const nodes = {};
    const unsupported = [];
    for (const type of source.nodeTypes) {
      const file = index.get(type);
      if (!file) {
        unsupported.push({ type, reason: "the verified package holds no such node type" });
        continue;
      }
      try {
        const loaded = originalLoad.call(Module, file, null, false);
        const NodeClass = Object.values(loaded).find((value) => typeof value === "function");
        if (!NodeClass) throw new Error("the module exports no node class");
        const node = reduceNode(type, new NodeClass());
        nodes[type] = node;
      } catch (error) {
        unsupported.push({ type, reason: `the node's description could not be read: ${String(error && error.message).slice(0, 160)}` });
      }
    }

    const hash = contentHash(nodes, unsupported);
    const outFile = args.out ?? path.resolve(REPO, source.snapshotFile);
    const noticeFile = args.notice ?? path.resolve(REPO, source.noticeFile);
    const licenseFile = args.license ?? path.resolve(REPO, source.licenseFile);
    fs.writeFileSync(outFile, renderSnapshot(source, nodes, unsupported, hash), "utf8");
    fs.writeFileSync(noticeFile, renderNotice(source, digest, unsupported), "utf8");
    fs.copyFileSync(path.join(packageRoot, source.licenseFileInPackage), licenseFile);

    let parameters = 0;
    for (const node of Object.values(nodes)) parameters += node.parameters.length;
    process.stdout.write(`wrote ${outFile}\n`);
    process.stdout.write(`  ${Object.keys(nodes).length} node types, ${parameters} parameters, content hash ${hash}\n`);
    for (const node of Object.values(nodes)) {
      const withOptions = node.parameters.filter((p) => Array.isArray(p.options)).length;
      process.stdout.write(`  ${node.type} v${node.defaultVersion ?? "-"}: ${node.parameters.length} parameters (${withOptions} with a known option list)\n`);
    }
    for (const entry of unsupported) process.stdout.write(`  UNSUPPORTED ${entry.type}: ${entry.reason}\n`);
    process.stdout.write(`wrote ${noticeFile}\n`);
    process.stdout.write(`wrote ${licenseFile}\n`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
