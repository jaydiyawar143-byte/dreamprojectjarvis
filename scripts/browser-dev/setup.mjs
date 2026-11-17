#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Local development material for browsing through the isolated browser service.
//
//   node scripts/browser-dev/setup.mjs [--dir <folder>] [--days <n>]
//
// WRITES FILES ONLY. It never starts, stops or builds anything, never reads a
// `.env` file, and never prints a secret. Everything lands in one folder
// OUTSIDE this repository (default: ~/.jarvis-browser-dev), because a private
// key must not sit where `git add` can reach it:
//
//   tls/api/      client.crt  client.key  ca.crt     -> mounted into the API only
//   tls/service/  server.crt  server.key  ca.crt     -> mounted into the browser service only
//   browser-dev.env                       key id, shared secret, switches (random, per run)
//   docker-compose.browser-dev.yml        gives the API the three values that docker-compose.browser.yml
//                                         leaves to `.env`, so nothing has to be added to `.env`
//
// The throwaway CA signs both certificates and its private key is deleted at
// once, so nothing can mint another certificate from it. Certificates last
// `--days` (default 7). The server certificate names `browser-service`, the
// host in the URL the API uses; the client certificate names `jarvis-api`,
// the identity both sides sign over. It refuses to overwrite anything.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PEER_IDENTITY = "jarvis-api";
const SERVICE_HOST = "browser-service";

function argument(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

const target = resolve(argument("--dir", join(homedir(), ".jarvis-browser-dev")));
const days = Number(argument("--days", "7"));
if (!Number.isInteger(days) || days < 1 || days > 30) fail("--days must be a whole number from 1 to 30");

const inside = relative(REPO, target);
if (inside === "" || (!inside.startsWith("..") && !inside.includes(`:`))) {
  fail("the folder must be OUTSIDE the repository, so a private key can never be staged");
}
if (existsSync(target) && readdirSync(target).length > 0) {
  fail(`${target} is not empty; choose another --dir. Nothing is overwritten.`);
}

const openssl = findOpenssl();
if (!openssl) fail("openssl was not found. Git for Windows ships one at C:\\Program Files\\Git\\usr\\bin\\openssl.exe");

const tls = join(target, "tls");
const apiDir = join(tls, "api");
const serviceDir = join(tls, "service");
const work = join(target, ".work");
for (const dir of [apiDir, serviceDir, work]) mkdirSync(dir, { recursive: true });

const KEY = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];

// 1. A throwaway CA.
run(["req", "-x509", ...KEY, "-keyout", join(work, "ca.key"), "-out", join(work, "ca.crt"), "-days", String(days),
  "-subj", "/CN=jarvis-browser-dev-ca",
  "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);

// 2. Leaf certificates, signed by it.
function leaf(name, commonName, extensions, keyOut, certOut) {
  const csr = join(work, `${name}.csr`);
  const ext = join(work, `${name}.ext`);
  writeFileSync(ext, extensions.join("\n") + "\n");
  run(["req", "-new", ...KEY, "-keyout", keyOut, "-out", csr, "-subj", `/CN=${commonName}`]);
  run(["x509", "-req", "-in", csr, "-CA", join(work, "ca.crt"), "-CAkey", join(work, "ca.key"), "-CAcreateserial",
    "-out", certOut, "-days", String(days), "-extfile", ext]);
}
leaf("server", SERVICE_HOST,
  ["basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature", "extendedKeyUsage=serverAuth", `subjectAltName=DNS:${SERVICE_HOST}`],
  join(serviceDir, "server.key"), join(serviceDir, "server.crt"));
leaf("client", PEER_IDENTITY,
  ["basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature", "extendedKeyUsage=clientAuth", `subjectAltName=DNS:${PEER_IDENTITY}`],
  join(apiDir, "client.key"), join(apiDir, "client.crt"));

// 3. Each side gets the CA certificate, and only that; then the CA key is gone.
for (const dir of [apiDir, serviceDir]) writeFileSync(join(dir, "ca.crt"), readFileSync(join(work, "ca.crt")));
rmSync(work, { recursive: true, force: true });
for (const key of [join(apiDir, "client.key"), join(serviceDir, "server.key")]) tryChmod(key, 0o644);

// 4. The shared values and the override.
const posix = (path) => path.split(sep).join("/");
const envFile = join(target, "browser-dev.env");
writeFileSync(envFile, [
  "# Throwaway values for LOCAL browser testing. Generated; never commit, never reuse.",
  `JARVIS_BROWSER_TLS_DIR=${posix(tls)}`,
  `BROWSER_SERVICE_KEY_ID=dev-${randomBytes(6).toString("hex")}`,
  `BROWSER_SERVICE_SHARED_SECRET=${randomBytes(32).toString("hex")}`,
  `BROWSER_SERVICE_PEER_IDENTITY=${PEER_IDENTITY}`,
  "# Chromium is its own switch: it stays off unless this is exactly true.",
  "BROWSER_SERVICE_CHROMIUM_ENABLED=true",
  "# Required whenever Chromium is on: how long a screenshot or download is kept.",
  "BROWSER_ARTIFACT_RETENTION_HOURS=24",
  "# The origin of the web app that calls this API (CORS). The default stack's own web app is 3100.",
  "JARVIS_DEV_WEB_ORIGIN=http://localhost:3000",
  "# The API image to run. Build one with step 2 (see docs/DEVELOPMENT.md); never reuse the `latest` tag.",
  "JARVIS_API_IMAGE=jarvis-app:browser-dev",
  "",
].join("\n"));

const overrideFile = join(target, "docker-compose.browser-dev.yml");
writeFileSync(overrideFile, [
  "# Generated. Adds what docker-compose.browser.yml leaves to `.env`, and pins the API image.",
  "services:",
  "  api:",
  "    image: ${JARVIS_API_IMAGE:?set JARVIS_API_IMAGE}",
  "    pull_policy: never",
  "    environment:",
  "      BROWSER_SERVICE_KEY_ID: ${BROWSER_SERVICE_KEY_ID:?missing}",
  "      BROWSER_SERVICE_SHARED_SECRET: ${BROWSER_SERVICE_SHARED_SECRET:?missing}",
  "      BROWSER_SERVICE_PEER_IDENTITY: ${BROWSER_SERVICE_PEER_IDENTITY:?missing}",
  "      CORS_ORIGIN: ${JARVIS_DEV_WEB_ORIGIN:-http://localhost:3100}",
  "",
].join("\n"));

const compose = `docker compose --env-file "${posix(envFile)}" -f docker-compose.yml -f docker-compose.browser.yml -f "${posix(overrideFile)}" --profile browser-service`;
console.log(`Wrote local browser material to ${posix(target)} (certificates valid ${days} days).`);
console.log("No secret was printed. Nothing was started, built or changed.\n");
console.log("Next (each step needs your approval; see docs/DEVELOPMENT.md, \"Browsing in local development\"):");
console.log(`  1. build the browser service:  ${compose} build browser-service`);
console.log(`  2. start only what is needed:  ${compose} up -d --no-deps browser-egress browser-service api`);

function findOpenssl() {
  for (const candidate of ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"]) {
    const probe = spawnSync(candidate, ["version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function run(args) {
  const done = spawnSync(openssl, args, { encoding: "utf8" });
  if (done.status !== 0) {
    // openssl's own output can name a key path; show only that it failed and where.
    rmSync(work, { recursive: true, force: true });
    fail(`openssl ${args[0]} failed (exit ${done.status})`);
  }
}

function tryChmod(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    /* Windows: modes are advisory. */
  }
}

function fail(message) {
  console.error(`setup: ${message}`);
  process.exit(1);
}
