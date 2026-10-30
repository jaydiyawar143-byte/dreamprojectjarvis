// ---------------------------------------------------------------------------
// Phase 19, Stage 19.2 audit (H3, M1) — the browser container's deployment.
//
// The browser service runs Chromium against pages nobody at JARVIS wrote, so
// its container is the one most likely to be compromised. These pin what it
// is given, read from `docker-compose.yml` itself:
//
//   - no `env_file`: every variable is named, and none is a database URL, a
//     JWT or encryption secret, or a Meta, OpenAI, Google or n8n credential;
//   - every `${…}` it interpolates is a browser variable, so a new line cannot
//     quietly pull one of those in through the project .env;
//   - its own network, shared with the API and not with PostgreSQL;
//   - no published port, and still a profile — off unless asked for;
//   - a health check that asks the loopback health listener, which works under
//     mutual TLS, instead of plain HTTP on the mTLS port, which cannot.
//
// The network is NOT egress control and nothing here says it is: default-deny
// egress is Stage 19.3.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

const REPO = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, REPO), "utf8").replace(/\r\n/g, "\n");

const compose = read("docker-compose.yml");

/** One top-level service's block: from its key to the next service key or top-level key. */
function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name}`).toBeGreaterThan(0);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n(?: {2}[a-z][a-z0-9-]*:\n|[a-z][a-z0-9-]*:)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The keys of a block's two-space-deeper mapping under `key:`, ignoring comments. */
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

/** The block without its comment lines, so a comment cannot satisfy or fail a check. */
const code = (block: string) =>
  block
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

const browser = serviceBlock("browser-service");
const api = serviceBlock("api");
const postgres = serviceBlock("postgres");
const environment = mappingKeys(browser, "environment");

/** Variables that would hand the browser container a secret it has no use for. */
const FORBIDDEN = /DATABASE|POSTGRES|JWT|ENCRYPTION|SECRET_KEY|META_|FACEBOOK|OPENAI|ANTHROPIC|GOOGLE|N8N|WHATSAPP|ELEVENLABS|OMNIROUTE|REDIS/i;

/** Fixed, non-secret values the container needs beside its own variables. */
const FIXED_LITERALS = new Map([
  ["NODE_ENV", "production"],
  ["CHROME_PATH", "/usr/bin/chromium"],
]);

describe("the browser container receives only what it names (H3)", () => {
  it("has no env_file", () => {
    expect(code(browser)).not.toMatch(/^ {4}env_file:/m);
    // No .env file is named anywhere in the block (a mounted or listed one).
    expect(code(browser)).not.toMatch(/(?:^|[\s"'/:])\.env(?:\.[\w-]+)?(?:["'\s]|$)/m);
  });

  it("names only browser variables and two fixed literals", () => {
    expect(environment.size).toBeGreaterThan(0);
    for (const [name, value] of environment) {
      if (FIXED_LITERALS.has(name)) {
        expect(value, name).toBe(FIXED_LITERALS.get(name));
        continue;
      }
      expect(name, name).toMatch(/^BROWSER_/);
      expect(name, name).not.toMatch(FORBIDDEN);
    }
  });

  it("interpolates nothing but its own variable, under its own name", () => {
    const references = [...code(browser).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g)].map((match) => match[1]!);
    expect(references.length).toBeGreaterThan(0);
    for (const name of references) {
      expect(name).toMatch(/^BROWSER_/);
      expect(name).not.toMatch(FORBIDDEN);
    }
    for (const [name, value] of environment) {
      const reference = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/);
      if (reference) expect(reference[1], name).toBe(name);
    }
  });

  it("passes every variable the service reads, except the two it only refuses", () => {
    const sources = readdirSync(new URL("apps/browser-service/src/", REPO))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => read(`apps/browser-service/src/${file}`))
      .join("\n");
    const read_ = new Set([...sources.matchAll(/\b(BROWSER_SERVICE_[A-Z_]+)\b/g)].map((match) => match[1]!));
    read_.delete("BROWSER_SERVICE_HEADERS");
    // Refused at start-up if set to their old insecure values; never passed.
    const refusedOnly = ["BROWSER_SERVICE_REQUIRE_MTLS", "BROWSER_SERVICE_TRUST_FORWARDED_PEER_IDENTITY"];
    for (const name of refusedOnly) {
      expect(read_.has(name), name).toBe(true);
      expect(environment.has(name), name).toBe(false);
      read_.delete(name);
    }
    for (const name of read_) expect(environment.has(name), `${name} is read but not passed`).toBe(true);
  });

  it("keeps Chromium off unless switched on", () => {
    expect(environment.get("BROWSER_SERVICE_CHROMIUM_ENABLED")).toBe("${BROWSER_SERVICE_CHROMIUM_ENABLED:-false}");
  });
});

describe("the browser container's network position (H3)", () => {
  it("is on the browser network only", () => {
    expect(listItems(browser, "networks")).toEqual(["browser"]);
  });

  it("does not share a network with PostgreSQL", () => {
    // PostgreSQL names no network, so it is on `default` alone.
    expect(code(postgres)).not.toMatch(/^ {4}networks:/m);
    expect(listItems(browser, "networks")).not.toContain("default");
  });

  it("is reached by the API, the one service on both networks", () => {
    expect(listItems(api, "networks").sort()).toEqual(["browser", "default"]);
  });

  it("declares the network at the top level, as INTERNAL: no route out but the egress proxy (Phase 19.3)", () => {
    expect(compose).toMatch(/\nnetworks:\n(?: +#.*\n)* {2}browser:\n {4}internal: true\n/);
  });

  it("publishes no port and stays behind its profile", () => {
    expect(code(browser)).not.toMatch(/^ {4}ports:/m);
    expect(code(browser)).toMatch(/^ {4}profiles: \["browser-service"\]$/m);
  });

  it("keeps its container limits", () => {
    const body = code(browser);
    expect(body).toMatch(/^ {4}read_only: true$/m);
    expect(listItems(browser, "cap_drop")).toEqual(["ALL"]);
    expect(listItems(browser, "security_opt")).toContain("no-new-privileges:true");
    expect(body).not.toMatch(/seccomp[:=]unconfined|privileged: true|SYS_ADMIN/);
  });
});

describe("the browser container's health check works under mutual TLS (M1)", () => {
  const test = browser.match(/healthcheck:\n(?: +#.*\n)* +test:\n +\[\n +"CMD-SHELL",\n +"(.+)",\n +\]/)?.[1];

  it("asks the loopback health listener, on the port the service is told to use", () => {
    expect(test).toBeDefined();
    expect(environment.get("BROWSER_SERVICE_HEALTH_PORT")).toBe("3201");
    expect(test).toContain("http://127.0.0.1:3201/healthz");
  });

  it("never asks the mutual-TLS port", () => {
    expect(test).not.toContain(":3200");
    expect(test).not.toContain("rejectUnauthorized");
    expect(test).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  it("is a port the service listens on separately from the mTLS one", () => {
    expect(environment.get("BROWSER_SERVICE_PORT")).toBe("3200");
    expect(read("apps/browser-service/src/index.ts")).toContain('const HEALTH_HOST = "127.0.0.1"');
  });
});

// ---------------------------------------------------------------------------
// Phase 19.3 — the egress proxy is the browser's only way out.
//
// What this file can prove is the declared topology. Whether Docker enforces
// it on a given host — that the internal network really has no other path —
// is the container check S11 (docs/DEPLOYMENT.md), not this test.
// ---------------------------------------------------------------------------

const egress = serviceBlock("browser-egress");
const egressEnvironment = mappingKeys(egress, "environment");
const web = serviceBlock("web");

describe("the browser's egress proxy (Phase 19.3)", () => {
  it("is the only service on both the internal browser network and the outbound one", () => {
    expect(listItems(egress, "networks").sort()).toEqual(["browser", "browser-egress"]);
    for (const [name, block] of [["postgres", postgres], ["api", api], ["web", web], ["browser-service", browser]] as const) {
      expect(listItems(block, "networks"), name).not.toContain("browser-egress");
    }
    expect(compose).toMatch(/\n {2}browser-egress:\n(?! {4}internal: true)/);
  });

  it("is never on the default network, so PostgreSQL is not even routable from it", () => {
    expect(listItems(egress, "networks")).not.toContain("default");
  });

  it("runs the proxy from the browser-service image, behind the same profile, with no port and no env_file", () => {
    const body = code(egress);
    expect(body).toMatch(/^ {4}command: \["node", "apps\/browser-service\/dist\/egress\/main\.js"\]$/m);
    expect(body).toMatch(/^ {4}image: jarvis-browser-service:latest$/m);
    expect(body).toMatch(/^ {4}profiles: \["browser-service"\]$/m);
    expect(body).not.toMatch(/^ {4}(ports|env_file):/m);
    expect(read("apps/browser-service/src/egress/main.ts")).toContain("loadEgressConfig");
  });

  it("receives only its own variables, each under its own name", () => {
    for (const [name, value] of egressEnvironment) {
      if (name === "NODE_ENV") continue;
      expect(name).toMatch(/^BROWSER_EGRESS_/);
      const reference = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/);
      if (reference) expect(reference[1], name).toBe(name);
    }
    const sources = readdirSync(new URL("apps/browser-service/src/egress/", REPO))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => read(`apps/browser-service/src/egress/${file}`))
      .join("\n");
    for (const name of new Set([...sources.matchAll(/\b(BROWSER_EGRESS_[A-Z_]+)\b/g)].map((match) => match[1]!))) {
      expect(egressEnvironment.has(name), `${name} is read but not passed`).toBe(true);
    }
  });

  it("keeps its container limits", () => {
    const body = code(egress);
    expect(body).toMatch(/^ {4}read_only: true$/m);
    expect(listItems(egress, "cap_drop")).toEqual(["ALL"]);
    expect(listItems(egress, "security_opt")).toContain("no-new-privileges:true");
    expect(body).not.toMatch(/privileged: true|NET_ADMIN|NET_RAW|SYS_ADMIN/);
  });

  it("has a loopback health check, so the browser starts only once it answers", () => {
    expect(egress).toContain("http://127.0.0.1:3129/healthz");
    expect(egressEnvironment.get("BROWSER_EGRESS_HEALTH_PORT")).toBe("3129");
    expect(code(browser)).toMatch(/depends_on:\n {6}browser-egress:\n {8}condition: service_healthy/);
  });

  it("is the address the browser service is told to send everything to", () => {
    expect(environment.get("BROWSER_SERVICE_EGRESS_PROXY_URL")).toBe("http://browser-egress:3128");
    expect(egressEnvironment.get("BROWSER_EGRESS_PORT")).toBe("3128");
    expect(listItems(browser, "networks")).toEqual(["browser"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 19.4 — the artifact store is durable, and nothing else is.
//
// What this file can prove is the declaration: a named volume, at the
// directory the service is told to use, owned by the unprivileged user in the
// image. That Docker keeps the volume's contents across a recreated container
// on a given host is a container check (docs/DEPLOYMENT.md), not this test.
// ---------------------------------------------------------------------------

const ARTIFACT_DIR = "/var/lib/jarvis-browser/artifacts";
const ARTIFACT_VOLUME = "jarvis-browser-artifacts";

describe("the browser's artifact store (Phase 19.4)", () => {
  it("is a named volume at the directory the service is told to use, never the tmpfs", () => {
    expect(environment.get("BROWSER_SERVICE_DOWNLOAD_DIR")).toBe(ARTIFACT_DIR);
    expect(listItems(browser, "volumes")).toEqual([`${ARTIFACT_VOLUME}:${ARTIFACT_DIR}`]);
    for (const mount of listItems(browser, "tmpfs")) expect(ARTIFACT_DIR.startsWith(mount.split(":")[0]!)).toBe(false);
    expect(compose).toMatch(new RegExp(`\\nvolumes:\\n(?: +.*\\n)*? {2}${ARTIFACT_VOLUME}:\\n`));
  });

  it("is mounted into the browser service alone — not the proxy, the API or the web app", () => {
    for (const [name, block] of [["browser-egress", egress], ["api", api], ["web", web], ["postgres", postgres]] as const) {
      expect(code(block), name).not.toContain(ARTIFACT_VOLUME);
    }
    // The root filesystem stays read-only beside it.
    expect(code(browser)).toMatch(/^ {4}read_only: true$/m);
  });

  it("passes every artifact variable the service reads, retention with no default", () => {
    const sources = [
      ...readdirSync(new URL("apps/browser-service/src/", REPO))
        .filter((file) => file.endsWith(".ts"))
        .map((file) => `apps/browser-service/src/${file}`),
      "packages/browser/src/config.ts",
    ]
      .map(read)
      .join("\n");
    const names = new Set([...sources.matchAll(/\b(BROWSER_ARTIFACT_[A-Z_]+)\b/g)].map((match) => match[1]!));
    expect(names.size).toBeGreaterThanOrEqual(6);
    for (const name of names) expect(environment.get(name), `${name} is read but not passed`).toBe(`\${${name}:-}`);
    expect(environment.get("BROWSER_MAX_DOWNLOAD_BYTES")).toBe("${BROWSER_MAX_DOWNLOAD_BYTES:-}");
  });

  it("is created in the image, owned by the unprivileged user and closed to everyone else", () => {
    const dockerfile = read("apps/browser-service/Dockerfile");
    const runtime = dockerfile.slice(dockerfile.indexOf("FROM base AS runtime"));
    const create = runtime.indexOf(`mkdir -p ${ARTIFACT_DIR}`);
    expect(create).toBeGreaterThan(0);
    expect(runtime).toContain("chown -R node:node /var/lib/jarvis-browser");
    expect(runtime).toContain(`chmod 700 ${ARTIFACT_DIR}`);
    // Before the switch to the unprivileged user, which the service runs as.
    expect(create).toBeLessThan(runtime.indexOf("\nUSER node"));
  });

  it("generates the Prisma client before the image compiles the service, which reaches @jarvis/db", () => {
    // @jarvis/browser -> @jarvis/memory -> @jarvis/db, whose tsc build needs
    // the generated client; `turbo build` does not generate it. Without this
    // step the image did not build from Stage 19.2 until the 19.4 review.
    const dockerfile = read("apps/browser-service/Dockerfile");
    const build = dockerfile.slice(dockerfile.indexOf("FROM base AS build"), dockerfile.indexOf("FROM base AS runtime"));
    const lines = build.split("\n");
    const generate = lines.findIndex((line) => /^RUN pnpm --filter @jarvis\/db exec prisma generate\b/.test(line));
    const compile = lines.findIndex((line) => line.startsWith("RUN pnpm --filter @jarvis/browser-service... build"));
    expect(generate).toBeGreaterThan(-1);
    expect(compile).toBeGreaterThan(-1);
    // After the schema arrives with the sources, before the compile needs it.
    expect(generate).toBeGreaterThan(lines.indexOf("COPY . ."));
    expect(generate).toBeLessThan(compile);
  });
});
