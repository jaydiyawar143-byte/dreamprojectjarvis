-- Sprint 9.5 — composite index for the audit-backed rate limiter.
--
-- `DbBackedRateLimiter.check()` counts a single user's audit rows inside a
-- sliding window on every approval and voice request. Its own source comment
-- said "with an index on (userId, createdAt)", but only two single-column
-- indexes existed, so the window predicate was evaluated over everything that
-- user had ever done.
--
-- NOT `CONCURRENTLY`. That would avoid the write lock, but Prisma wraps each
-- migration in a transaction and Postgres refuses CREATE INDEX CONCURRENTLY
-- inside one (SQLSTATE 25001) — the COMMIT/BEGIN workaround fails here in
-- practice. A plain CREATE INDEX takes a SHARE lock: reads continue, writes to
-- AuditLog block for the duration of the build.
--
-- That is an accepted trade for this table at this scale. On a large AuditLog
-- in a busy production deployment, build the index by hand with CONCURRENTLY
-- outside a transaction and then mark this migration applied with
-- `prisma migrate resolve --applied`.
CREATE INDEX IF NOT EXISTS "AuditLog_userId_createdAt_idx"
  ON "AuditLog" ("userId", "createdAt");
