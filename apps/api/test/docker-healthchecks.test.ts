// Phase 13 — every service in the Docker stack says whether it is healthy.
//
// Before Phase 13 the web service had no healthcheck, so `docker compose ps`
// and anything waiting on it could only see that the container existed. These
// pin the three checks, and that each one asks an endpoint that really exists
// and is the right kind of question for a container health probe.
//
// They also pin the one timing that has to agree across two files: the API
// gives in-flight work JARVIS_SHUTDOWN_GRACE_MS to finish, and Docker kills a
// container `stop_grace_period` after asking it to stop. If Docker's is the
// shorter, the grace period is a fiction.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPO = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, REPO), "utf8").replace(/\r\n/g, "\n");

const compose = read("docker-compose.yml");
const service = (name: string, next: string) =>
  compose.slice(compose.indexOf(`\n  ${name}:\n`), compose.indexOf(next));

const postgres = service("postgres", "\n  api:\n");
const api = service("api", "\n  web:\n");
const web = service("web", "\nvolumes:");

/** The command a service's healthcheck runs. */
const healthTest = (block: string): string | undefined =>
  block.match(/healthcheck:\n(?: +#.*\n)* +test: \["CMD-SHELL", "(.+)"\]/)?.[1];

/** A duration such as `40s`, in milliseconds. */
const durationMs = (block: string, key: string): number | undefined => {
  const seconds = block.match(new RegExp(`^ +${key}: (\\d+)s$`, "m"))?.[1];
  return seconds === undefined ? undefined : Number(seconds) * 1000;
};

describe("docker-compose — every service has a healthcheck", () => {
  it("postgres is asked whether it accepts connections", () => {
    expect(healthTest(postgres)).toContain("pg_isready");
  });

  it("the API is asked whether its process is alive, on its in-container port", () => {
    expect(healthTest(api)).toBe("wget -qO- http://127.0.0.1:3001/api/v1/health/live || exit 1");
    // The route it asks exists.
    expect(read("apps/api/src/routes/health.ts")).toContain('router.get("/live"');
  });

  it("the web app is asked the same of its own health endpoint", () => {
    expect(healthTest(web)).toBe("wget -qO- http://127.0.0.1:3000/healthz || exit 1");
    // The port it asks is the one `next start` is told to listen on...
    expect(web).toContain('"--port", "3000"');
    // ...and the route it asks exists.
    expect(existsSync(new URL("apps/web/src/app/healthz/route.ts", REPO))).toBe(true);
  });

  it.each([
    ["api", api],
    ["web", web],
  ])("the %s check allows for a slow start before it counts a failure", (_name, block) => {
    expect(durationMs(block, "interval")).toBeGreaterThan(0);
    expect(durationMs(block, "timeout")).toBeGreaterThan(0);
    expect(durationMs(block, "start_period")).toBeGreaterThanOrEqual(20_000);
    expect(block).toMatch(/^ +retries: \d+$/m);
  });
});

describe("docker-compose — Docker waits as long as the API's own shutdown does", () => {
  it("gives the API longer to stop than its default shutdown grace period", () => {
    const defaultGraceMs = Number(
      read("packages/config/src/index.ts").match(
        /JARVIS_SHUTDOWN_GRACE_MS: z\.coerce\s*\.number\(\)[\s\S]*?\.default\((\d+)\)/
      )?.[1]
    );
    expect(defaultGraceMs).toBeGreaterThan(0);

    const stopGraceMs = durationMs(api, "stop_grace_period");
    expect(stopGraceMs, "the api service must set stop_grace_period").toBeDefined();
    // Room for the drain AND for releasing resources after it.
    expect(stopGraceMs!).toBeGreaterThan(defaultGraceMs);
  });
});
