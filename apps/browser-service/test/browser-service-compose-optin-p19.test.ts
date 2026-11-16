// ---------------------------------------------------------------------------
// Phase 19, P0 — the API's opt-in wiring to the browser service.
//
// The default stack must never browse: in docker-compose.yml the API has
// BROWSER_ENABLED "false" and no browser-service URL, whatever .env says. The
// one way in is docker-compose.browser.yml, named on the command line. These
// pin both halves, and that the opt-in file changes the wiring and nothing
// else — no network, port, limit, capability or security option, no
// Chromium switch, and no private key in the container that does not own it.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const REPO = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, REPO), "utf8").replace(/\r\n/g, "\n");

const base = read("docker-compose.yml");
const optIn = read("docker-compose.browser.yml");

/** One service's block in a compose file: from its key to the next service or top-level key. */
function serviceBlock(file: string, name: string): string {
  const start = file.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const rest = file.slice(start + 1);
  const next = rest.slice(1).search(/\n(?: {2}[a-z][a-z0-9-]*:\n|[a-z][a-z0-9-]*:)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The keys of a block's mapping under `key:`, ignoring comments. */
function mappingKeys(block: string, key: string): Map<string, string> {
  const lines = block.split("\n");
  const at = lines.findIndex((line) => line === `    ${key}:`);
  const result = new Map<string, string>();
  if (at < 0) return result;
  for (const line of lines.slice(at + 1)) {
    if (/^ {6}#/.test(line) || line.trim() === "") continue;
    const entry = line.match(/^ {6}([A-Za-z_][A-Za-z0-9_]*): ?(.*)$/);
    if (!entry) break;
    result.set(entry[1]!, entry[2]!);
  }
  return result;
}

/** A list under `key:` (`- item` lines), ignoring comments. */
function listItems(block: string, key: string): string[] {
  const lines = block.split("\n");
  const at = lines.findIndex((line) => line === `    ${key}:`);
  if (at < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^ {6}#/.test(line)) continue;
    const item = line.match(/^ {6}- (.+)$/);
    if (!item) break;
    items.push(item[1]!.trim());
  }
  return items;
}

/** The file without comment lines, so a comment can neither satisfy nor fail a check. */
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** The service keys a compose file defines. */
function serviceNames(file: string): string[] {
  const body = code(file);
  const start = body.indexOf("\nservices:\n");
  const after = body.slice(start + "\nservices:\n".length);
  const end = after.search(/\n[a-z][a-z0-9-]*:/);
  const section = end < 0 ? after : after.slice(0, end);
  return [...section.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]!);
}

const TLS_DIR = `\${JARVIS_BROWSER_TLS_DIR:?set JARVIS_BROWSER_TLS_DIR to the browser-service TLS directory}`;
const MOUNT = "/run/jarvis-browser-tls";

describe("the default stack never browses (Phase 19, P0)", () => {
  const api = serviceBlock(base, "api");
  const apiEnvironment = mappingKeys(api, "environment");

  it("pins BROWSER_ENABLED off for the API, as a literal no .env value can change", () => {
    expect(apiEnvironment.get("BROWSER_ENABLED")).toBe('"false"');
  });

  it("gives the API no browser-service URL, credentials or TLS paths of its own", () => {
    for (const name of apiEnvironment.keys()) expect(name, name).not.toMatch(/^BROWSER_SERVICE_/);
  });

  it("keeps the browser service behind its profile and Chromium off by default", () => {
    const browser = serviceBlock(base, "browser-service");
    expect(code(browser)).toMatch(/^ {4}profiles: \["browser-service"\]$/m);
    expect(mappingKeys(browser, "environment").get("BROWSER_SERVICE_CHROMIUM_ENABLED")).toBe(
      `\${BROWSER_SERVICE_CHROMIUM_ENABLED:-false}`
    );
  });

  it("has no docker-compose.override.yml, which compose would load without being asked", () => {
    expect(existsSync(new URL("docker-compose.override.yml", REPO))).toBe(false);
  });
});

describe("docker-compose.browser.yml — the explicit opt-in (Phase 19, P0)", () => {
  const api = serviceBlock(optIn, "api");
  const browser = serviceBlock(optIn, "browser-service");
  const apiEnvironment = mappingKeys(api, "environment");
  const browserEnvironment = mappingKeys(browser, "environment");

  it("touches the API and the browser service, and nothing else", () => {
    expect(serviceNames(optIn).sort()).toEqual(["api", "browser-service"]);
    // No top-level networks or volumes: the wiring rides what the base defines.
    expect(code(optIn)).not.toMatch(/^(networks|volumes|secrets|configs):/m);
  });

  it("switches browsing on for the API, through the service, over mutual TLS", () => {
    expect(apiEnvironment.get("BROWSER_ENABLED")).toBe('"true"');
    // The compose service name and the port the service listens on (base file).
    expect(apiEnvironment.get("BROWSER_SERVICE_URL")).toBe("https://browser-service:3200");
    expect(mappingKeys(serviceBlock(base, "browser-service"), "environment").get("BROWSER_SERVICE_PORT")).toBe("3200");
    expect(apiEnvironment.get("BROWSER_SERVICE_CLIENT_CERT_PATH")).toBe(`${MOUNT}/client.crt`);
    expect(apiEnvironment.get("BROWSER_SERVICE_CLIENT_KEY_PATH")).toBe(`${MOUNT}/client.key`);
    expect(apiEnvironment.get("BROWSER_SERVICE_CA_PATH")).toBe(`${MOUNT}/ca.crt`);
    expect([...apiEnvironment.keys()].sort()).toEqual(
      [
        "BROWSER_ENABLED",
        "BROWSER_SERVICE_CA_PATH",
        "BROWSER_SERVICE_CLIENT_CERT_PATH",
        "BROWSER_SERVICE_CLIENT_KEY_PATH",
        "BROWSER_SERVICE_URL",
      ].sort()
    );
  });

  it("points the service at its own certificate, key and CA, and sets nothing else", () => {
    expect(Object.fromEntries(browserEnvironment)).toEqual({
      BROWSER_SERVICE_TLS_CERT_PATH: `${MOUNT}/server.crt`,
      BROWSER_SERVICE_TLS_KEY_PATH: `${MOUNT}/server.key`,
      BROWSER_SERVICE_TLS_CA_PATH: `${MOUNT}/ca.crt`,
    });
  });

  it("never throws the Chromium switch", () => {
    expect(code(optIn)).not.toContain("BROWSER_SERVICE_CHROMIUM_ENABLED");
  });

  it("mounts each side's TLS material read-only into that side only, from a directory that must be named", () => {
    expect(listItems(api, "volumes")).toEqual([`"${TLS_DIR}/api:${MOUNT}:ro"`]);
    expect(listItems(browser, "volumes")).toEqual([`"${TLS_DIR}/service:${MOUNT}:ro"`]);
    // The API never sees the service's key, and the service never sees the API's.
    expect(code(api)).not.toContain("/service:");
    expect(code(api)).not.toContain("server.key");
    expect(code(browser)).not.toContain("/api:");
    expect(code(browser)).not.toContain("client.key");
  });

  it("interpolates nothing but the TLS directory — no secret is written into this file", () => {
    const references = [...code(optIn).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    expect(new Set(references)).toEqual(new Set(["JARVIS_BROWSER_TLS_DIR"]));
    expect(code(optIn)).not.toMatch(/SHARED_SECRET|KEY_ID|PEER_IDENTITY/);
  });

  it("changes no network, port, limit, capability, user or security option", () => {
    for (const block of [api, browser]) {
      expect(code(block)).not.toMatch(
        /^ {4}(networks|ports|expose|security_opt|cap_add|cap_drop|privileged|user|read_only|tmpfs|pids_limit|mem_limit|cpus|shm_size|env_file|profiles|network_mode|devices|image|build|command|entrypoint):/m
      );
    }
    expect(code(optIn)).not.toMatch(/seccomp[:=]unconfined|privileged: true|SYS_ADMIN|--no-sandbox/);
  });
});
