// ---------------------------------------------------------------------------
// Phase 17 Stage 3A — the tenant (Organization) operator command: guards and
// runner.
//
// The writer itself lives in @jarvis/db (maintenance/tenant-admin) and is the
// only code that creates or changes a tenant, a membership or a connector
// owner. This file decides WHETHER it may run, and reports what it did:
//
//   - DRY RUN BY DEFAULT. Without --execute the same checks run and nothing is
//     written; the result says what would change. `list` only reads.
//   - STRICT ARGUMENTS. A verb, then --option=value pairs. A malformed,
//     repeated, unknown or misplaced option is refused, never guessed at.
//     Refusals never echo values.
//   - EXPLICIT TARGET. DATABASE_URL must be supplied explicitly (the entry
//     point reads it before anything can load packages/db/.env), and
//     --confirm-target=<host>:<port>/<database> must match it — the guard the
//     memory backfill uses.
//   - ATTRIBUTED. --as names the existing account the change is recorded
//     under; every write commits in one transaction with its audit row.
//   - ONLY KNOWN CONNECTIONS. --provider/--connector must name a connection in
//     core's SHARED_CONNECTOR_KEYS: one a route actually enforces.
//   - NO SECRETS. The console gets the verb, the target's host:port/database,
//     ids and role names. Unexpected errors are reported by error name only.
//
// It imports only TYPES from @jarvis/db, so importing it never loads Prisma.
// ---------------------------------------------------------------------------

import { SHARED_CONNECTOR_KEYS, TENANT_ROLES, isTenantRole } from "@jarvis/core";
import type { TenantAdminCommand, TenantAdminOptions, TenantAdminResult, TenantAdminVerb } from "@jarvis/db";
import { resolveBackfillTarget } from "../s7-memory-backfill/backfill-cli.js";

/** Process exit codes (sysexits). */
export const TENANT_ADMIN_EXIT = { OK: 0, USAGE: 64, REFUSED: 65, FAILED: 70 } as const;

export interface TenantAdminArgs {
  command: TenantAdminCommand;
  confirmTarget: string;
  actorUserId: string;
  execute: boolean;
}

export interface TenantAdminDeps {
  run(command: TenantAdminCommand, options: TenantAdminOptions): Promise<TenantAdminResult>;
  print(event: Record<string, unknown>): void;
}

const VERBS: Readonly<Record<TenantAdminVerb, { options: readonly string[]; writes: boolean }>> = {
  "create-tenant": { options: ["name", "owner"], writes: true },
  "add-member": { options: ["tenant", "user", "role"], writes: true },
  "set-role": { options: ["tenant", "user", "role"], writes: true },
  "remove-member": { options: ["tenant", "user"], writes: true },
  "assign-connector": { options: ["provider", "connector", "tenant"], writes: true },
  "unassign-connector": { options: ["provider", "connector"], writes: true },
  list: { options: ["tenant"], writes: false },
};

const COMMON_OPTIONS = ["confirm-target", "as"] as const;
const TARGET_PATTERN = /^[A-Za-z0-9.-]+:\d{1,5}\/[A-Za-z0-9_-]+$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 120;

const isVerb = (value: string): value is TenantAdminVerb => Object.prototype.hasOwnProperty.call(VERBS, value);

/** Parses `<verb> --option=value … [--execute]`. Never echoes a value. */
export function parseTenantAdminArgs(argv: string[]): { ok: true; args: TenantAdminArgs } | { ok: false; error: string } {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb.startsWith("--")) {
    return { ok: false, error: `The first argument must be a verb: ${Object.keys(VERBS).join(", ")}` };
  }
  if (!isVerb(verb)) return { ok: false, error: `Unknown verb; expected one of ${Object.keys(VERBS).join(", ")}` };

  const spec = VERBS[verb];
  const allowed = new Set<string>([...spec.options, ...COMMON_OPTIONS]);
  const values = new Map<string, string>();
  let execute = false;

  for (const arg of rest) {
    const match = /^--([a-z][a-z-]*)(=([\s\S]*))?$/.exec(arg);
    if (!match) return { ok: false, error: "Unrecognised argument; after the verb every argument must be --option or --option=value" };
    const name = match[1]!;
    const value = match[3];
    if (name === "execute") {
      if (value !== undefined) return { ok: false, error: "--execute takes no value" };
      if (execute) return { ok: false, error: "--execute is given more than once" };
      if (!spec.writes) return { ok: false, error: `${verb} only reads; --execute does not apply` };
      execute = true;
      continue;
    }
    if (!allowed.has(name)) return { ok: false, error: `--${name} is not an option of ${verb}` };
    if (values.has(name)) return { ok: false, error: `--${name} is given more than once` };
    if (value === undefined || value.trim() === "") return { ok: false, error: `--${name} needs a value (--${name}=...)` };
    values.set(name, value);
  }

  for (const name of [...COMMON_OPTIONS, ...spec.options]) {
    if (!values.has(name)) return { ok: false, error: `${verb} requires --${name}` };
  }

  const confirmTarget = values.get("confirm-target")!;
  if (!TARGET_PATTERN.test(confirmTarget)) return { ok: false, error: "--confirm-target must be <host>:<port>/<database>" };

  for (const name of ["as", "owner", "tenant", "user"]) {
    const value = values.get(name);
    if (value !== undefined && !ID_PATTERN.test(value)) return { ok: false, error: `--${name} must be an id` };
  }

  const role = values.get("role");
  if (role !== undefined && !isTenantRole(role)) {
    return { ok: false, error: `--role must be one of ${TENANT_ROLES.join(", ")}` };
  }

  const provider = values.get("provider");
  const connector = values.get("connector");
  if (provider !== undefined || connector !== undefined) {
    const known = SHARED_CONNECTOR_KEYS.some((key) => key.providerId === provider && key.connector === connector);
    if (!known) {
      const keys = SHARED_CONNECTOR_KEYS.map((key) => `${key.providerId}/${key.connector}`).join(", ");
      return { ok: false, error: `--provider/--connector must name a connection whose owner can be recorded: ${keys}` };
    }
  }

  const name = values.get("name");
  if (name !== undefined && name.trim().length > NAME_MAX) {
    return { ok: false, error: `--name must be at most ${NAME_MAX} characters` };
  }

  const v = (key: string) => values.get(key)!;
  let command: TenantAdminCommand;
  switch (verb) {
    case "create-tenant":
      command = { verb, name: v("name").trim(), ownerUserId: v("owner") };
      break;
    case "add-member":
    case "set-role":
      command = { verb, tenantId: v("tenant"), userId: v("user"), role: v("role") as TenantAdminCommandRole };
      break;
    case "remove-member":
      command = { verb, tenantId: v("tenant"), userId: v("user") };
      break;
    case "assign-connector":
      command = { verb, providerId: v("provider"), connector: v("connector"), tenantId: v("tenant") };
      break;
    case "unassign-connector":
      command = { verb, providerId: v("provider"), connector: v("connector") };
      break;
    case "list":
      command = { verb, tenantId: v("tenant") };
      break;
  }

  return { ok: true, args: { command, confirmTarget, actorUserId: v("as"), execute } };
}

type TenantAdminCommandRole = Extract<TenantAdminCommand, { verb: "add-member" }>["role"];

/** Runs the command. Returns the process exit code. */
export async function runTenantAdmin(
  argv: string[],
  explicitDatabaseUrl: string | undefined,
  deps: TenantAdminDeps
): Promise<number> {
  const parsed = parseTenantAdminArgs(argv);
  if (!parsed.ok) {
    deps.print({ event: "tenant_admin_usage_error", error: parsed.error });
    return TENANT_ADMIN_EXIT.USAGE;
  }
  const { command, confirmTarget, actorUserId, execute } = parsed.args;

  const resolved = resolveBackfillTarget(explicitDatabaseUrl, confirmTarget);
  if (!resolved.ok) {
    deps.print({ event: "tenant_admin_usage_error", error: resolved.error });
    return TENANT_ADMIN_EXIT.USAGE;
  }
  const target = resolved.target;

  let result: TenantAdminResult;
  try {
    result = await deps.run(command, { actorUserId, execute });
  } catch (error) {
    // A transaction that failed has written nothing. Name only, never the message.
    deps.print({
      event: "tenant_admin_failed",
      verb: command.verb,
      target,
      errorName: error instanceof Error ? error.name : typeof error,
      written: false,
    });
    return TENANT_ADMIN_EXIT.FAILED;
  }

  if (!result.ok) {
    deps.print({ event: "tenant_admin_refused", verb: result.verb, target, code: result.code, message: result.message });
    return TENANT_ADMIN_EXIT.REFUSED;
  }

  if (command.verb === "list") {
    deps.print({ event: "tenant_admin_list", verb: result.verb, target, detail: result.detail });
  } else if (result.executed) {
    deps.print({ event: "tenant_admin_executed", verb: result.verb, target, detail: result.detail });
  } else {
    deps.print({
      event: "tenant_admin_dry_run",
      verb: result.verb,
      target,
      detail: result.detail,
      note: "Nothing was written. Re-run with --execute to make this change.",
    });
  }
  return TENANT_ADMIN_EXIT.OK;
}
