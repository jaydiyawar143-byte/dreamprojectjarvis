// ---------------------------------------------------------------------------
// Phase 19, P0 — the real-Chromium E2E's relay. TEST ONLY.
//
// The browser service is on the INTERNAL `browser` network, which Docker gives
// no route in or out, so a published port cannot reach it. In production the
// API is on that network. In the E2E the API-side code runs on the host, so
// this container — on `browser` and on a separate access network whose port is
// published to 127.0.0.1 only — forwards raw TCP to browser-service:3200.
//
// It forwards bytes and nothing else: the mutual-TLS session is between the
// host-side client and the browser service, end to end. This relay never
// terminates TLS, holds no certificate and reads no request. The browser
// service's own network position is unchanged.
// ---------------------------------------------------------------------------

import { connect, createServer } from "node:net";

const TARGET_HOST = "browser-service";
const TARGET_PORT = 3200;
const LISTEN_PORT = 3443;

const server = createServer((client) => {
  const upstream = connect({ host: TARGET_HOST, port: TARGET_PORT });
  const end = () => {
    client.destroy();
    upstream.destroy();
  };
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", end);
  upstream.on("error", end);
  client.on("close", end);
  upstream.on("close", end);
});

server.listen(LISTEN_PORT, "0.0.0.0", () =>
  console.log(JSON.stringify({ service: "browser-e2e-relay", event: "listening", port: LISTEN_PORT }))
);

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
