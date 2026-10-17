// ---------------------------------------------------------------------------
// Phase 17 Stage 3A — the tenant (Organization) operator command: entry point.
//
//   DATABASE_URL=<target> npx tsx scripts/tenant-admin/run.ts <verb> \
//     --confirm-target=<host>:<port>/<database> --as=<operator account id> [options] [--execute]
//
//   create-tenant       --name=<display name> --owner=<account id>
//   add-member          --tenant=<id> --user=<account id> --role=owner|admin|member|viewer
//   set-role            --tenant=<id> --user=<account id> --role=owner|admin|member|viewer
//   remove-member       --tenant=<id> --user=<account id>
//   assign-connector    --provider=n8n --connector=mcp --tenant=<id>
//   unassign-connector  --provider=n8n --connector=mcp
//   list                --tenant=<id>
//
// Run from apps/api. A dry run unless --execute is given. See
// tenant-admin-cli.ts for every guard. DATABASE_URL is read HERE, before
// anything imports the Prisma client — which would otherwise load
// packages/db/.env and silently point at the development database — and it
// is handed to the client explicitly.
// ---------------------------------------------------------------------------

import { runTenantAdmin, TENANT_ADMIN_EXIT } from "./tenant-admin-cli.js";

const explicitDatabaseUrl = process.env.DATABASE_URL;

let exitCode: number = TENANT_ADMIN_EXIT.FAILED;
try {
  const db = await import("@jarvis/db");
  const prisma = new db.PrismaClient(
    explicitDatabaseUrl ? { datasources: { db: { url: explicitDatabaseUrl } } } : undefined
  );
  try {
    exitCode = await runTenantAdmin(process.argv.slice(2), explicitDatabaseUrl, {
      run: (command, options) => db.runTenantAdminCommand(prisma, command, options),
      print: (event) => console.log(JSON.stringify(event)),
    });
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
} catch (error) {
  // Start-up failed (a module or the Prisma client). Name only, never the message.
  console.log(
    JSON.stringify({
      event: "tenant_admin_failed",
      stage: "startup",
      errorName: error instanceof Error ? error.name : typeof error,
    })
  );
  exitCode = TENANT_ADMIN_EXIT.FAILED;
}
process.exit(exitCode);
