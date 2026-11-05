// ---------------------------------------------------------------------------
// The one Socket.IO origin the dashboard connects to.
//
// The API is served under `/api/v1`; Socket.IO is mounted at the origin. Both
// streams that use it (system metrics and the Virtual Office) derive their URL
// here, so a deployment that changes `NEXT_PUBLIC_API_URL` cannot leave one
// stream pointed at the old host.
// ---------------------------------------------------------------------------

export const SOCKET_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1"
).replace(/\/api\/v1\/?$/, "");
