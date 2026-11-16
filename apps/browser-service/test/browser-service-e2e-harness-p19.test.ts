// ---------------------------------------------------------------------------
// Phase 19, P0 — the real-Chromium E2E harness, held to its isolation.
//
// The harness starts real containers, so what it may touch is pinned here, by
// reading its files: the compose override changes no control of the real
// services, switches Chromium on in its own project only, names and labels
// everything it creates, and publishes nothing but a loopback relay; the
// runner never prunes, never uses a shell, removes only its own exact names,
// and never reads the real .env; the fixture egress can neither resolve nor
// dial anything real.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const REPO = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, REPO), "utf8").replace(/\r\n/g, "\n");

const e2e = read("scripts/browser-e2e/docker-compose.e2e.yml");
const runner = read("scripts/browser-e2e/run.mjs");
const egress = read("scripts/browser-e2e/fixture/fixture-egress.mjs");
const relay = read("scripts/browser-e2e/fixture/relay.mjs");
const verifier = read("scripts/browser-e2e/fixture/verify-artifacts.mjs");
const vitestConfig = read("apps/api/vitest.browser-e2e.config.ts");

const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");

function serviceBlock(file: string, name: string): string {
  const start = file.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const rest = file.slice(start + 1);
  const next = rest.slice(1).search(/\n(?: {2}[a-z][a-z0-9-]*:\n|[a-z][a-z0-9-]*:)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function topLevelKeys(block: string): string[] {
  return [...code(block).matchAll(/^ {4}([a-z_]+):/gm)].map((match) => match[1]!);
}

const PROJECT = "jarvis-p19-browser-e2e";

describe("the E2E compose override (Phase 19, P0)", () => {
  const browser = serviceBlock(e2e, "browser-service");
  const proxy = serviceBlock(e2e, "browser-egress");
  const relayService = serviceBlock(e2e, "browser-e2e-relay");

  it("defines the two real services and one relay, and nothing else — no database, API or web container", () => {
    const services = [...code(e2e).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]!);
    expect(services.slice(0, 3).sort()).toEqual(["browser-e2e-relay", "browser-egress", "browser-service"]);
    expect(code(e2e)).not.toMatch(/^ {2}(postgres|api|web):/m);
  });

  it("changes none of the real browser service's controls: only its name, image, labels, environment and TLS mount", () => {
    expect(topLevelKeys(browser).sort()).toEqual(["container_name", "environment", "image", "labels", "volumes"]);
    expect(topLevelKeys(proxy).sort()).toEqual(["command", "container_name", "environment", "image", "labels", "volumes"]);
  });

  it("names, tags and labels everything it creates, so nothing existing is reused or overwritten", () => {
    for (const block of [browser, proxy, relayService]) {
      expect(code(block)).toMatch(new RegExp(`^ {4}container_name: ${PROJECT}-[a-z]+$`, "m"));
      expect(code(block)).toContain("image: ${JARVIS_BROWSER_E2E_IMAGE:?");
      expect(code(block)).toMatch(/^ {6}jarvis\.test: browser-e2e$/m);
    }
    expect(code(e2e)).not.toContain("jarvis-browser-service:latest");
    expect(code(e2e)).not.toMatch(/container_name: jarvis-docker-/);
  });

  it("switches Chromium on in this isolated project only, with the TLS material read-only", () => {
    expect(code(browser)).toContain('BROWSER_SERVICE_CHROMIUM_ENABLED: "true"');
    expect(code(browser)).toContain(`"\${JARVIS_BROWSER_E2E_TLS_DIR:?set by scripts/browser-e2e/run.mjs}/service:/run/jarvis-browser-tls:ro"`);
    expect(code(proxy)).toContain('"./fixture:/e2e:ro"');
    expect(code(proxy)).toContain('command: ["node", "/e2e/fixture-egress.mjs"]');
  });

  it("publishes only the relay, on loopback only, and hardens it like the real services", () => {
    expect(code(browser)).not.toMatch(/ports:/);
    expect(code(proxy)).not.toMatch(/ports:/);
    expect(code(relayService)).toContain(`- "127.0.0.1:\${JARVIS_BROWSER_E2E_PORT:?set by scripts/browser-e2e/run.mjs}:3443"`);
    expect(code(relayService)).not.toMatch(/- "?(0\.0\.0\.0:)?\$\{JARVIS_BROWSER_E2E_PORT[^}]*\}:3443/);
    expect(code(relayService)).toMatch(/^ {4}read_only: true$/m);
    expect(code(relayService)).toMatch(/^ {6}- no-new-privileges:true$/m);
    expect(code(relayService)).toMatch(/^ {4}cap_drop:\n {6}- ALL$/m);
    expect(code(relayService)).toMatch(/^ {4}pids_limit: \d+$/m);
    expect(code(relayService)).toMatch(/^ {4}mem_limit: \d+m$/m);
    expect(code(relayService)).not.toMatch(/environment:|env_file:/);
    expect(code(relayService)).toMatch(/^ {6}- browser\n {6}- browser-e2e-access$/m);
  });

  it("never runs anything unconfined, privileged, or with a sandbox-disabling switch", () => {
    expect(code(e2e)).not.toMatch(/seccomp[:=]unconfined|privileged: true|SYS_ADMIN|cap_add|--no-sandbox|--disable-gpu-sandbox|network_mode/);
  });
});

describe("the E2E runner (Phase 19, P0)", () => {
  const body = code(runner);

  it("never prunes, never uses a shell, never removes by pattern", () => {
    expect(body).not.toMatch(/\bprune\b/);
    expect(body).not.toMatch(/shell:\s*true|execSync|\bexec\(/);
    expect(body).not.toMatch(/"-v"|--volumes|--rmi|"-a",\s*"-q"[^)]*rm/);
    expect(body).not.toMatch(/\$\(docker/);
  });

  it("removes exactly its own volume and image tag, each after checking its label", () => {
    expect(body).toContain('docker(["volume", "rm", VOLUME])');
    expect(body).toContain('docker(["rmi", image])');
    expect(body).toMatch(/lines\(volumeLabel\.stdout\)\[0\] === PROJECT/);
    expect(body).toMatch(/lines\(imageLabel\.stdout\)\[0\] === LABEL_VALUE && users\.length === 0/);
    expect(body).toContain(`export const PROJECT = "${PROJECT}";`);
    expect(body).toContain(`export const VOLUME = \`\${PROJECT}_jarvis-browser-artifacts\`;`);
  });

  it("refuses to start when anything already carries the project's name, and checks the inventory afterwards", () => {
    expect(body).toMatch(/const taken = collisions\(before\);/);
    expect(body).toMatch(/if \(taken\.length > 0\)[\s\S]{0,400}return 2;/);
    expect(body).toMatch(/const after = inventory\(\);/);
  });

  it("starts only the isolated services, without building through compose", () => {
    expect(body).toContain('"up", "-d", "--no-build", "--wait", "--wait-timeout", "240", "browser-service", "browser-egress", "browser-e2e-relay"');
    expect(body).toContain('"-p",\n    PROJECT,');
  });

  it("gives compose an empty .env and never reads the real one", () => {
    expect(body).toContain('writeFileSync(join(work, ".env"), "")');
    expect(body).not.toMatch(/readFileSync\([^)]*\.env/);
    expect(body).not.toMatch(/join\(REPO, "\.env"\)/);
  });

  it("keeps the throwaway secrets in a temporary directory outside the repository, and deletes it", () => {
    expect(body).toContain('mkdtempSync(join(tmpdir(), "jarvis-browser-e2e-"))');
    expect(body).toContain("rmSync(work, { recursive: true, force: true })");
    expect(body).toContain('randomBytes(32).toString("hex")');
  });

  it("builds a new, unique tag and never jarvis-browser-service:latest", () => {
    expect(body).toMatch(/const image = `\$\{PROJECT\}\/browser-service:/);
    expect(body).not.toContain("jarvis-browser-service:latest");
  });
});

describe("the fixture scripts (Phase 19, P0)", () => {
  it("the egress runs the real proxy and policy, and can resolve and dial nothing real", () => {
    expect(egress).toContain('from "/workspace/apps/browser-service/dist/egress/config.js"');
    expect(egress).toContain('from "/workspace/apps/browser-service/dist/egress/proxy.js"');
    expect(egress).toContain("policy: config.policy");
    expect(egress).not.toMatch(/from "node:dns|systemResolver/);
    // Only the judged public address is wired, and only to the in-process site.
    expect(egress).toMatch(/if \(address === PUBLIC_ADDRESS && port === 80\) return connect\(\{ host: "127\.0\.0\.1", port: sitePort \}\);/);
    expect(egress).toMatch(/throw Object\.assign\(new Error\("ENOTFOUND"\)/);
  });

  it("the relay forwards bytes to the browser service and terminates no TLS", () => {
    expect(relay).toContain('const TARGET_HOST = "browser-service";');
    expect(relay).not.toMatch(/node:tls|node:https|createSecureContext|readFileSync/);
  });

  it("the artifact check uses the store's scoped reads and prints no bytes", () => {
    expect(verifier).toContain("store.get(input.owner");
    expect(verifier).toContain("store.readBytes(stranger");
    expect(verifier).not.toMatch(/toString\("(base64|utf8|hex)"\)/);
  });

  it("the E2E's vitest configuration collects the E2E file and nothing else", () => {
    expect(vitestConfig).toContain('include: ["test/e2e/**/*.e2e.ts"]');
    expect(vitestConfig).toContain("fileParallelism: false");
  });
});
