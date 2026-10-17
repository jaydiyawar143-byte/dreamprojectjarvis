// ---------------------------------------------------------------------------
// Phase 17 Stage 3A — the tenant (Organization) operator command.
//
// The guards and the runner, with the writer injected: no database is reached
// here (the writer's own transactions are proven against PostgreSQL in
// packages/db/test/tenant-foundation-p17-pg.integration.test.ts). Held:
//
//   • strict arguments, refused without echoing a value;
//   • the explicit-target guard — DATABASE_URL must be given, and must match
//     --confirm-target;
//   • a dry run unless --execute, and `list` never writes;
//   • only connections a route enforces can be assigned an owner;
//   • refusal and failure exit codes, and output that carries no credential;
//   • the boundary: nothing in the runtime imports the writer, and the
//     runtime's tenant repository can only read.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import {
  parseTenantAdminArgs,
  runTenantAdmin,
  TENANT_ADMIN_EXIT,
} from "../scripts/tenant-admin/tenant-admin-cli.js";
import type { TenantAdminCommand, TenantAdminOptions, TenantAdminResult } from "@jarvis/db";

const DB_URL = "postgresql://jarvis:VERY-SECRET-PASSWORD@db.internal:5432/jarvis_prod";
const TARGET = "db.internal:5432/jarvis_prod";
const COMMON = [`--confirm-target=${TARGET}`, "--as=operator-1"];

function harness(result: TenantAdminResult | Error = { ok: true, verb: "add-member", executed: false, detail: { tenantId: "t1" } }) {
  const printed: Array<Record<string, unknown>> = [];
  const runs: Array<{ command: TenantAdminCommand; options: TenantAdminOptions }> = [];
  const deps = {
    run: vi.fn(async (command: TenantAdminCommand, options: TenantAdminOptions) => {
      runs.push({ command, options });
      if (result instanceof Error) throw result;
      return result;
    }),
    print: (event: Record<string, unknown>) => printed.push(event),
  };
  return { deps, printed, runs };
}

describe("parseTenantAdminArgs", () => {
  it("parses every verb", () => {
    const cases: Array<[string[], TenantAdminCommand]> = [
      [["create-tenant", "--name=Acme Ltd", "--owner=user-1", ...COMMON], { verb: "create-tenant", name: "Acme Ltd", ownerUserId: "user-1" }],
      [["add-member", "--tenant=t1", "--user=u2", "--role=member", ...COMMON], { verb: "add-member", tenantId: "t1", userId: "u2", role: "member" }],
      [["set-role", "--tenant=t1", "--user=u2", "--role=viewer", ...COMMON], { verb: "set-role", tenantId: "t1", userId: "u2", role: "viewer" }],
      [["remove-member", "--tenant=t1", "--user=u2", ...COMMON], { verb: "remove-member", tenantId: "t1", userId: "u2" }],
      [["assign-connector", "--provider=n8n", "--connector=mcp", "--tenant=t1", ...COMMON], { verb: "assign-connector", providerId: "n8n", connector: "mcp", tenantId: "t1" }],
      [["unassign-connector", "--provider=n8n", "--connector=mcp", ...COMMON], { verb: "unassign-connector", providerId: "n8n", connector: "mcp" }],
      [["list", "--tenant=t1", ...COMMON], { verb: "list", tenantId: "t1" }],
    ];
    for (const [argv, command] of cases) {
      const parsed = parseTenantAdminArgs(argv);
      expect(parsed, argv[0]).toEqual({ ok: true, args: { command, confirmTarget: TARGET, actorUserId: "operator-1", execute: false } });
    }
  });

  it("is a dry run unless --execute is given", () => {
    const parsed = parseTenantAdminArgs(["remove-member", "--tenant=t1", "--user=u2", ...COMMON, "--execute"]);
    expect(parsed.ok && parsed.args.execute).toBe(true);
  });

  it.each([
    [[], /first argument must be a verb/],
    [["--execute"], /first argument must be a verb/],
    [["delete-tenant", ...COMMON], /Unknown verb/],
    [["list", "t1", ...COMMON], /Unrecognised argument/],
    [["list", "--tenant=t1", "--tenant=t2", ...COMMON], /more than once/],
    [["list", "--tenant", ...COMMON], /needs a value/],
    [["list", "--tenant=t1", "--role=owner", ...COMMON], /not an option of list/],
    [["list", "--tenant=t1", ...COMMON, "--execute"], /only reads/],
    [["add-member", "--tenant=t1", "--user=u2", ...COMMON], /requires --role/],
    [["add-member", "--tenant=t1", "--user=u2", "--role=superuser", ...COMMON], /--role must be one of owner, admin, member, viewer/],
    [["add-member", "--tenant=t1", "--user=u2", "--role=OWNER", ...COMMON], /--role must be one of/],
    [["list", "--tenant=t1", "--as=operator-1"], /requires --confirm-target/],
    [["list", "--tenant=t1", `--confirm-target=${TARGET}`], /requires --as/],
    [["list", "--tenant=../t1", ...COMMON], /--tenant must be an id/],
    [["assign-connector", "--provider=n8n", "--connector=rest", "--tenant=t1", ...COMMON], /connection whose owner can be recorded/],
    [["assign-connector", "--provider=zapier", "--connector=mcp", "--tenant=t1", ...COMMON], /connection whose owner can be recorded/],
    [["remove-member", "--tenant=t1", "--user=u2", ...COMMON, "--execute=yes"], /takes no value/],
    [["create-tenant", `--name=${"x".repeat(121)}`, "--owner=u1", ...COMMON], /at most 120/],
  ])("refuses %j", (argv, error) => {
    const parsed = parseTenantAdminArgs(argv as string[]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(error);
  });

  it("never echoes a value it refuses — a mistyped argument can be a database URL", () => {
    for (const argv of [
      ["list", DB_URL, ...COMMON],
      ["list", `--tenant=${DB_URL}`, ...COMMON],
      ["add-member", "--tenant=t1", "--user=u2", `--role=${DB_URL}`, ...COMMON],
      ["list", "--tenant=t1", `--confirm-target=${DB_URL}`, "--as=operator-1"],
    ]) {
      const parsed = parseTenantAdminArgs(argv);
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain("VERY-SECRET-PASSWORD");
    }
  });
});

describe("runTenantAdmin", () => {
  it("requires DATABASE_URL to be set explicitly, and never runs without it", async () => {
    const h = harness();
    const exit = await runTenantAdmin(["list", "--tenant=t1", ...COMMON], undefined, h.deps);
    expect(exit).toBe(TENANT_ADMIN_EXIT.USAGE);
    expect(h.deps.run).not.toHaveBeenCalled();
    expect(String(h.printed[0]!.error)).toMatch(/DATABASE_URL must be set explicitly/);
  });

  it("refuses a --confirm-target that does not match DATABASE_URL, and prints no credential", async () => {
    const h = harness();
    const exit = await runTenantAdmin(["list", "--tenant=t1", "--confirm-target=localhost:5432/jarvis", "--as=operator-1"], DB_URL, h.deps);
    expect(exit).toBe(TENANT_ADMIN_EXIT.USAGE);
    expect(h.deps.run).not.toHaveBeenCalled();
    expect(JSON.stringify(h.printed)).not.toContain("VERY-SECRET-PASSWORD");
  });

  it("runs a dry run by default and says nothing was written", async () => {
    const h = harness();
    const exit = await runTenantAdmin(["add-member", "--tenant=t1", "--user=u2", "--role=member", ...COMMON], DB_URL, h.deps);
    expect(exit).toBe(TENANT_ADMIN_EXIT.OK);
    expect(h.runs[0]!.options).toEqual({ actorUserId: "operator-1", execute: false });
    expect(h.printed[0]).toMatchObject({ event: "tenant_admin_dry_run", verb: "add-member", target: TARGET });
    expect(String(h.printed[0]!.note)).toMatch(/Nothing was written/);
  });

  it("writes only with --execute", async () => {
    const h = harness({ ok: true, verb: "add-member", executed: true, detail: { tenantId: "t1", userId: "u2", role: "member" } });
    const exit = await runTenantAdmin(["add-member", "--tenant=t1", "--user=u2", "--role=member", ...COMMON, "--execute"], DB_URL, h.deps);
    expect(exit).toBe(TENANT_ADMIN_EXIT.OK);
    expect(h.runs[0]!.options.execute).toBe(true);
    expect(h.printed[0]).toMatchObject({ event: "tenant_admin_executed", detail: { role: "member" } });
  });

  it("reports a refusal with its code and exit 65", async () => {
    const h = harness({ ok: false, verb: "set-role", code: "LAST_OWNER", message: "This would leave the tenant without an owner; add another owner first." });
    const exit = await runTenantAdmin(["set-role", "--tenant=t1", "--user=u1", "--role=member", ...COMMON, "--execute"], DB_URL, h.deps);
    expect(exit).toBe(TENANT_ADMIN_EXIT.REFUSED);
    expect(h.printed[0]).toMatchObject({ event: "tenant_admin_refused", code: "LAST_OWNER" });
  });

  it("reports a failure by error name only, says nothing was written, and exits 70", async () => {
    const failure = Object.assign(new Error(`connect failed ${DB_URL}`), { name: "PrismaClientInitializationError" });
    const h = harness(failure);
    const exit = await runTenantAdmin(["remove-member", "--tenant=t1", "--user=u2", ...COMMON, "--execute"], DB_URL, h.deps);
    expect(exit).toBe(TENANT_ADMIN_EXIT.FAILED);
    expect(h.printed[0]).toMatchObject({ event: "tenant_admin_failed", errorName: "PrismaClientInitializationError", written: false });
    expect(JSON.stringify(h.printed)).not.toContain("VERY-SECRET-PASSWORD");
    expect(JSON.stringify(h.printed)).not.toContain("connect failed");
  });

  it("lists without writing", async () => {
    const h = harness({ ok: true, verb: "list", executed: false, detail: { tenantId: "t1", members: [], connectors: [] } });
    const exit = await runTenantAdmin(["list", "--tenant=t1", ...COMMON], DB_URL, h.deps);
    expect(exit).toBe(TENANT_ADMIN_EXIT.OK);
    expect(h.runs[0]!.options.execute).toBe(false);
    expect(h.printed[0]).toMatchObject({ event: "tenant_admin_list" });
  });
});

// ---------------------------------------------------------------------------
// The boundary — the writer is operator-only, and the runtime only reads.
// ---------------------------------------------------------------------------

const REPO = new URL("../../../", import.meta.url);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, REPO), { withFileTypes: true })) {
    if (["node_modules", "dist", ".next"].includes(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe("the tenant writer is operator-only", () => {
  it("is imported by no route, service, tool, agent or memory code", () => {
    const runtime = ["apps/api/src", "packages/tools/src", "packages/agents/src", "packages/memory/src", "apps/web/src"];
    const importers = runtime
      .flatMap(sources)
      .filter((file) => /runTenantAdminCommand|maintenance\/tenant-admin/.test(readFileSync(new URL(file, REPO), "utf8")));
    expect(importers).toEqual([]);
  });

  it("leaves the runtime's tenant repository with reads only", () => {
    const source = readFileSync(new URL("packages/db/src/repositories/tenant-repository.ts", REPO), "utf8");
    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/\$executeRaw|\$queryRaw/);
  });

  it("reads a membership only by both ids — there is no read by user alone", () => {
    const source = readFileSync(new URL("packages/db/src/repositories/tenant-repository.ts", REPO), "utf8");
    expect(source).toMatch(/tenantId_userId: \{ tenantId, userId \}/);
    expect(source).not.toMatch(/tenantMembership\.findMany|tenantMembership\.findFirst/);
  });
});
