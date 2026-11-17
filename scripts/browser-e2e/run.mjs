#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Phase 19, P0 — the real-Chromium end-to-end run. OPT-IN, NEVER AUTOMATIC.
//
//   node scripts/browser-e2e/run.mjs            build, start, test, verify, clean up
//   node scripts/browser-e2e/run.mjs --dry-run  print the plan and every command; touch nothing
//   node scripts/browser-e2e/run.mjs --keep     leave the project running afterwards (for debugging)
//
// What it does, in order:
//
//   1. checks Docker answers, and REFUSES to start if any container, network,
//      volume or image already carries this project's name;
//   2. records every existing container, network, volume and image;
//   3. makes a temporary directory OUTSIDE the repository with throwaway TLS
//      material (a test CA, a server and a client certificate), a random
//      signing secret, an empty .env (so compose never reads the real one),
//      a copy of docker-compose.yml, the reviewed seccomp profiles, the E2E
//      override and the fixture scripts;
//   4. builds the browser-service image from the working tree under a NEW,
//      unique tag (never jarvis-browser-service:latest);
//   5. starts ONLY the isolated project `jarvis-p19-browser-e2e`: the real
//      browser service with real Chromium, the fixture egress and a relay
//      published on 127.0.0.1 only — no database, no API, no web container;
//   6. runs apps/api/test/e2e/browser-real-chromium.e2e.ts against it — the
//      orchestrator, ToolExecutor, the browser tools, RemoteBrowserRuntime,
//      the signed client and real mutual TLS;
//   7. checks the stored artifacts inside the service with its own scoped
//      reads (fixture/verify-artifacts.mjs);
//   8. keeps the logs as evidence, then removes EXACTLY what it created — the
//      project's containers and networks (`compose down`), its volume and its
//      image tag, each matched by name AND label — and the temporary
//      directory with its secrets. Nothing is pruned.
//   9. compares the inventory with step 2 and fails if anything else changed.
//
// Exit code: 0 when the E2E and the artifact check passed and the inventory is
// unchanged; 1 otherwise; 2 when a precondition stopped it before it started.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HERE = join(REPO, "scripts", "browser-e2e");

export const PROJECT = "jarvis-p19-browser-e2e";
export const CONTAINERS = [`${PROJECT}-browser`, `${PROJECT}-egress`, `${PROJECT}-relay`];
export const VOLUME = `${PROJECT}_jarvis-browser-artifacts`;
export const LABEL_KEY = "jarvis.test";
export const LABEL_VALUE = "browser-e2e";
const BROWSER_CONTAINER = CONTAINERS[0];
const FIXTURE_HOST = "fixture.browser-e2e.jarvis-p19.net";
const PEER = "jarvis-api-e2e";
const KEY_ID = "jarvis-api-e2e";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const KEEP = args.has("--keep");

const say = (line) => console.log(`[browser-e2e] ${line}`);
const slash = (path) => path.replace(/\\/g, "/");

/** Run a command with an argument array — never a shell — and return its result. */
function run(command, commandArgs, options = {}) {
  if (DRY_RUN) {
    say(`would run: ${command} ${commandArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const docker = (dockerArgs, options) => run("docker", dockerArgs, options);
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function inventory() {
  // Start time and restart count, not a status line: "Up 3 hours" changes by
  // itself, a restart does not hide behind it.
  const ids = lines(docker(["ps", "-a", "-q", "--no-trunc"]).stdout);
  const containers = ids.length
    ? lines(
        docker([
          "inspect",
          "--format",
          "{{.Id}}|{{.Name}}|{{.Image}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}",
          ...ids,
        ]).stdout
      )
    : [];
  return {
    containers: containers.map((l) => l.replace(/^([0-9a-f]+)\|\//, "$1|")).sort(),
    networks: lines(docker(["network", "ls", "--no-trunc", "--format", "{{.ID}}|{{.Name}}"]).stdout).sort(),
    volumes: lines(docker(["volume", "ls", "--format", "{{.Name}}"]).stdout).sort(),
    images: lines(docker(["images", "--no-trunc", "--format", "{{.ID}}|{{.Repository}}:{{.Tag}}"]).stdout).sort(),
  };
}

/** Anything already using this project's name, which this run would otherwise touch. */
function collisions(inv) {
  const named = (entry) => entry.split("|").some((part) => part.startsWith(PROJECT));
  return [...inv.containers, ...inv.networks, ...inv.volumes, ...inv.images].filter(named);
}

function freeLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function main() {
  // 1. Docker, and nothing of ours already there.
  const version = docker(["version", "--format", "{{.Server.Version}}"]);
  if (version.status !== 0) {
    say("Docker is not answering. Nothing was started.");
    return 2;
  }
  const before = DRY_RUN ? null : inventory();
  if (before) {
    const taken = collisions(before);
    if (taken.length > 0) {
      say(`refusing to start: ${taken.length} resource(s) already carry the name ${PROJECT}. Remove them by name first.`);
      for (const entry of taken) say(`  in use: ${entry.split("|").slice(0, 2).join(" ")}`);
      return 2;
    }
  }

  // 3. The temporary project directory, outside the repository.
  const work = DRY_RUN ? join(tmpdir(), "jarvis-browser-e2e-XXXXXX") : mkdtempSync(join(tmpdir(), "jarvis-browser-e2e-"));
  const evidence = DRY_RUN ? join(tmpdir(), "jarvis-browser-e2e-evidence-XXXXXX") : mkdtempSync(join(tmpdir(), "jarvis-browser-e2e-evidence-"));
  const port = DRY_RUN ? 0 : await freeLoopbackPort();
  const head = lines(run("git", ["-C", REPO, "rev-parse", "--short", "HEAD"]).stdout)[0] ?? "worktree";
  const image = `${PROJECT}/browser-service:${DRY_RUN ? "HEAD-xxxxxx" : `${head}-${randomBytes(3).toString("hex")}`}`;
  const secret = randomBytes(32).toString("hex");
  say(`project ${PROJECT}; image ${image}; relay 127.0.0.1:${port}; work dir ${work}`);

  if (!DRY_RUN) {
    mkdirSync(join(work, "apps", "browser-service", "seccomp"), { recursive: true });
    mkdirSync(join(work, "fixture"), { recursive: true });
    copyFileSync(join(REPO, "docker-compose.yml"), join(work, "docker-compose.yml"));
    for (const profile of ["browser-service.json", "docker-default-profiles-v0.2.4.json"]) {
      copyFileSync(join(REPO, "apps", "browser-service", "seccomp", profile), join(work, "apps", "browser-service", "seccomp", profile));
    }
    copyFileSync(join(HERE, "docker-compose.e2e.yml"), join(work, "docker-compose.e2e.yml"));
    cpSync(join(HERE, "fixture"), join(work, "fixture"), { recursive: true });
    writeFileSync(join(work, ".env"), "");

    // Throwaway TLS material from the service tests' own generator: a test CA,
    // a server certificate for localhost, a client certificate naming PEER,
    // and two that must be refused.
    const { createTestTls } = await import(
      pathToFileURL(join(REPO, "apps", "browser-service", "test", "helpers", "test-tls.ts")).href
    );
    const tls = createTestTls(PEER);
    const place = (from, ...to) => {
      mkdirSync(dirname(join(work, "tls", ...to)), { recursive: true });
      copyFileSync(from, join(work, "tls", ...to));
    };
    place(tls.serverCertPath, "service", "server.crt");
    place(tls.serverKeyPath, "service", "server.key");
    place(tls.caPath, "service", "ca.crt");
    place(tls.clientCertPath, "api", "client.crt");
    place(tls.clientKeyPath, "api", "client.key");
    place(tls.caPath, "api", "ca.crt");
    place(tls.otherClientCertPath, "refused", "other.crt");
    place(tls.otherClientKeyPath, "refused", "other.key");
    place(tls.strangerCertPath, "refused", "stranger.crt");
    place(tls.strangerKeyPath, "refused", "stranger.key");
    rmSync(tls.dir, { recursive: true, force: true });

    writeFileSync(
      join(work, "e2e.env"),
      [
        "# Throwaway values for one isolated E2E run. Nothing here is a real credential.",
        `BROWSER_SERVICE_KEY_ID=${KEY_ID}`,
        `BROWSER_SERVICE_SHARED_SECRET=${secret}`,
        `BROWSER_SERVICE_PEER_IDENTITY=${PEER}`,
        `JARVIS_BROWSER_E2E_IMAGE=${image}`,
        `JARVIS_BROWSER_E2E_TLS_DIR=${slash(join(work, "tls"))}`,
        `JARVIS_BROWSER_E2E_PORT=${port}`,
        `JARVIS_BROWSER_E2E_ALLOWLIST=${FIXTURE_HOST},private.${FIXTURE_HOST}`,
        `JARVIS_BROWSER_E2E_FIXTURE_HOST=${FIXTURE_HOST}`,
        "",
      ].join("\n")
    );
  }

  const compose = [
    "compose",
    "-p",
    PROJECT,
    "--project-directory",
    work,
    "-f",
    join(work, "docker-compose.yml"),
    "-f",
    join(work, "docker-compose.e2e.yml"),
    "--env-file",
    join(work, "e2e.env"),
    "--profile",
    "browser-service",
  ];

  let created = false;
  let testsPassed = false;
  let artifactsPassed = false;
  try {
    // 4. The image, from the working tree, under its own tag.
    say("building the browser-service image (a new tag; no existing tag is touched)");
    const build = docker(
      ["build", "--progress=plain", "-f", join(REPO, "apps", "browser-service", "Dockerfile"), "--target", "runtime",
        "--label", `${LABEL_KEY}=${LABEL_VALUE}`, "-t", image, REPO],
      { cwd: REPO }
    );
    if (!DRY_RUN) writeFileSync(join(evidence, "build.log"), `${build.stdout}\n${build.stderr}`);
    if (build.status !== 0) {
      say("the image did not build; see build.log in the evidence directory");
      return 1;
    }
    created = true;

    // 5. Only the isolated project.
    say("starting the isolated project: browser-service, browser-egress (fixture), browser-e2e-relay");
    const up = docker([...compose, "up", "-d", "--no-build", "--wait", "--wait-timeout", "240", "browser-service", "browser-egress", "browser-e2e-relay"]);
    if (!DRY_RUN) writeFileSync(join(evidence, "compose-up.log"), `${up.stdout}\n${up.stderr}`);
    if (up.status !== 0) {
      say("the project did not become healthy; see compose-up.log");
      return 1;
    }

    // 6. The E2E test, through the real path.
    say("running the real-Chromium E2E test");
    const test = run(
      process.execPath,
      [join(REPO, "apps", "api", "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vitest.browser-e2e.config.ts"],
      {
        cwd: join(REPO, "apps", "api"),
        env: {
          ...process.env,
          JARVIS_BROWSER_E2E: "1",
          JARVIS_BROWSER_E2E_URL: `https://localhost:${port}`,
          JARVIS_BROWSER_E2E_TLS_DIR: join(work, "tls"),
          JARVIS_BROWSER_E2E_KEY_ID: KEY_ID,
          JARVIS_BROWSER_E2E_SECRET: secret,
          JARVIS_BROWSER_E2E_PEER: PEER,
          JARVIS_BROWSER_E2E_FIXTURE_HOST: FIXTURE_HOST,
          JARVIS_BROWSER_E2E_RESULTS: join(evidence, "results.json"),
        },
      }
    );
    if (!DRY_RUN) writeFileSync(join(evidence, "e2e-test.log"), `${test.stdout}\n${test.stderr}`);
    testsPassed = test.status === 0;
    say(DRY_RUN ? "E2E test: not run (dry run)" : `E2E test exit code ${test.status}`);

    // 7. The artifacts, through the store's own scoped reads.
    const resultsPath = join(evidence, "results.json");
    if (DRY_RUN || existsSync(resultsPath)) {
      const verify = docker(
        ["exec", "-i", "-e", `JARVIS_E2E_ARTIFACTS=${DRY_RUN ? "{...}" : readFileSync(resultsPath, "utf8")}`, BROWSER_CONTAINER, "node", "--input-type=module", "-"],
        { input: DRY_RUN ? "" : readFileSync(join(HERE, "fixture", "verify-artifacts.mjs"), "utf8") }
      );
      if (!DRY_RUN) writeFileSync(join(evidence, "artifacts.log"), `${verify.stdout}\n${verify.stderr}`);
      artifactsPassed = verify.status === 0;
      say(DRY_RUN ? "artifact check: not run (dry run)" : `artifact check exit code ${verify.status}`);
    } else {
      say("no results file: the test did not reach the artifact steps");
    }
  } finally {
    // 8. Evidence first, then exactly what this run created.
    if (!DRY_RUN && created) {
      for (const name of CONTAINERS) {
        const logs = docker(["logs", name]);
        writeFileSync(join(evidence, `${name}.log`), `${logs.stdout}\n${logs.stderr}`);
      }
    }
    if (KEEP && !DRY_RUN) {
      say(`--keep: the project is still running and ${work} still holds its throwaway secrets. Remove both when done.`);
    } else {
      say("cleaning up: compose down (no -v), then the volume and the image tag by exact name and label");
      docker([...compose, "down"]);
      const volumeLabel = docker(["volume", "inspect", VOLUME, "--format", '{{index .Labels "com.docker.compose.project"}}']);
      if (DRY_RUN || lines(volumeLabel.stdout)[0] === PROJECT) docker(["volume", "rm", VOLUME]);
      const imageLabel = docker(["image", "inspect", image, "--format", `{{index .Config.Labels "${LABEL_KEY}"}}`]);
      const users = lines(docker(["ps", "-a", "--filter", `ancestor=${image}`, "--format", "{{.Names}}"]).stdout);
      if (DRY_RUN || (lines(imageLabel.stdout)[0] === LABEL_VALUE && users.length === 0)) docker(["rmi", image]);
      if (!DRY_RUN) rmSync(work, { recursive: true, force: true });
    }
  }

  // 9. Nothing else changed.
  if (DRY_RUN) {
    say("dry run: nothing was created, started or removed");
    return 0;
  }
  if (KEEP) return testsPassed && artifactsPassed ? 0 : 1;
  const after = inventory();
  const leftovers = collisions(after);
  const changed = ["containers", "networks", "volumes", "images"].filter(
    (kind) => JSON.stringify(before[kind]) !== JSON.stringify(after[kind])
  );
  writeFileSync(join(evidence, "inventory.json"), JSON.stringify({ before, after }, null, 2));
  say(`leftover project resources: ${leftovers.length}; inventory ${changed.length === 0 ? "unchanged" : `CHANGED (${changed.join(", ")})`}`);
  say(`evidence kept in ${evidence}`);
  return testsPassed && artifactsPassed && leftovers.length === 0 && changed.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      say(`stopped: ${String(error?.message ?? error).split("\n")[0]}`);
      process.exit(1);
    }
  );
}
