// ---------------------------------------------------------------------------
// Phase 13 — the web app's health endpoint.
//
// What a container orchestrator and an uptime monitor ask of this server:
// is it up, and can it answer a request?
//
// IT CHECKS NOTHING ELSE, on purpose. The browser calls the API directly, so
// this server needs nothing behind it to serve a page — and a health check
// that asked the API would report a healthy web server as down every time the
// API restarted. The API answers for itself, at /api/v1/health/live and
// /api/v1/health/ready.
//
// `force-dynamic` and `no-store`: a response rendered at build time, or served
// from a cache, would go on saying "ok" after the server had stopped.
//
// The body is fixed. It names the service and nothing about how it is
// configured.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { status: "ok", service: "jarvis-web", timestamp: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } }
  );
}
