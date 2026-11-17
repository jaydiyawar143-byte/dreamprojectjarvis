// ---------------------------------------------------------------------------
// Phase 19, P0 — the real-Chromium E2E's artifact check. TEST ONLY.
//
// Piped on stdin into the E2E browser-service container after the test run
// (`docker exec -i … node --input-type=module -`). It opens the service's own
// artifact store — the same `DownloadStore`, the same directory — and asks it,
// through its scoped reads, about the artifacts the test created:
//
//   - in the owner's scope: found, of the right kind, with the right bytes;
//   - in another user's scope, or another Organization's: NOT found.
//
// There is deliberately no artifact retrieval API or UI in this product yet;
// this uses the store's existing interface and nothing else. It prints ids,
// kinds, sizes and digests — never the bytes.
//
// Input: JARVIS_E2E_ARTIFACTS, a JSON object:
//   { owner: {userId, organizationId}, strangers: [{...}, ...],
//     screenshotId, downloadId, downloadSha256 }
// Exit: 0 every check passed, 1 otherwise.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { DownloadStore } from "/workspace/packages/browser/dist/index.js";

const input = JSON.parse(process.env.JARVIS_E2E_ARTIFACTS ?? "{}");
const results = [];
const record = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};

const store = new DownloadStore({
  root: process.env.BROWSER_SERVICE_DOWNLOAD_DIR ?? "/var/lib/jarvis-browser/artifacts",
  maxBytes: 64 * 1024 * 1024,
  retentionMs: 60 * 60 * 1000,
  maxBytesPerUser: 1024 * 1024 * 1024,
  maxBytesPerOrganization: 1024 * 1024 * 1024,
  maxArtifactsPerUser: 100_000,
  maxArtifactsPerOrganization: 100_000,
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

try {
  const shot = await store.get(input.owner, input.screenshotId);
  const shotBytes = await store.readBytes(input.owner, input.screenshotId);
  record("the screenshot is stored in its owner's scope", shot?.kind === "screenshot", shot ? `${shot.kind} ${shot.byteSize} B` : "not found");
  record(
    "its bytes are a PNG image, as large as the tool reported",
    Boolean(shotBytes && shotBytes.subarray(0, 8).equals(PNG) && shot && shotBytes.length === shot.byteSize),
    shotBytes ? `${shotBytes.length} B` : "no bytes"
  );

  const file = await store.get(input.owner, input.downloadId);
  const fileBytes = await store.readBytes(input.owner, input.downloadId);
  const digest = fileBytes ? createHash("sha256").update(fileBytes).digest("hex") : null;
  record("the download is stored in its owner's scope", file?.kind === "download", file ? `${file.mimeType} ${file.byteSize} B` : "not found");
  record("its bytes are exactly the fixture's file", digest === input.downloadSha256, digest ? digest.slice(0, 16) : "no bytes");
  record("its type was sniffed from its bytes", file?.mimeType === "text/csv", file?.mimeType ?? "none");
  record("its name was generated, not taken from the site", Boolean(file && file.fileName.startsWith(input.downloadId)), file?.fileName ?? "none");

  for (const stranger of input.strangers ?? []) {
    const label = `${stranger.userId === input.owner.userId ? "same user" : "another user"}, ${stranger.organizationId === input.owner.organizationId ? "same Organization" : "another Organization"}`;
    for (const [kind, id] of [
      ["screenshot", input.screenshotId],
      ["download", input.downloadId],
    ]) {
      const found = await store.get(stranger, id);
      const bytes = await store.readBytes(stranger, id);
      record(`the ${kind} is not found in another scope (${label})`, found === null && bytes === null);
    }
  }
} catch (error) {
  record("the artifact store could be read", false, String(error?.code ?? error?.name ?? "error"));
}

const failed = results.filter((pass) => !pass).length;
console.log(`ARTIFACTS: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
