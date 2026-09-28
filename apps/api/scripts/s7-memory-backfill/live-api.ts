// ---------------------------------------------------------------------------
// S7 Step 9B — does the LIVE API run the S7 memory code?
//
// The backfill is only safe while every memory writer keeps the vector and
// metadata.embedding together, which pre-S7 code does not. This looks inside
// the running API container, read-only:
//
//   docker inspect --format {{.State.Running}} <container>   -> "true" | "false"
//   docker exec <container> grep -q -F -- <text> <file>      -> exit code only
//
// A container's filesystem is the image it was created from, so the files it
// holds are the code its process loaded. Nothing else is read: never the
// container's environment (it holds the API's secrets), never file contents,
// never command output beyond the one running flag. Arguments go straight to
// the docker binary with no shell in between.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import type { CodeSignature, LiveApiInspection, SignatureStatus } from "./backfill-cli.js";

export type DockerExec = (args: string[]) => { status: number | null; stdout: string };

const DOCKER_TIMEOUT_MS = 15_000;

/** Runs the docker CLI directly (no shell); only the exit code and stdout are kept. */
export const dockerExec: DockerExec = (args) => {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: DOCKER_TIMEOUT_MS,
    windowsHide: true,
  });
  return { status: result.error ? null : result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
};

export function inspectLiveApiContainer(
  container: string,
  signatures: readonly CodeSignature[],
  exec: DockerExec = dockerExec
): LiveApiInspection {
  const inspected = exec(["inspect", "--format", "{{.State.Running}}", container]);
  if (inspected.status !== 0) return { running: null, signatures: [] };
  const flag = inspected.stdout.trim();
  if (flag !== "true") return { running: flag === "false" ? false : null, signatures: [] };

  return {
    running: true,
    signatures: signatures.map((signature) => {
      const { status } = exec(["exec", container, "grep", "-q", "-F", "--", signature.text, signature.file]);
      const outcome: SignatureStatus = status === 0 ? "present" : status === 1 ? "absent" : "unreadable";
      return { id: signature.id, status: outcome };
    }),
  };
}
