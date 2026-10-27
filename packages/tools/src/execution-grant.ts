import type { InputMode, ToolContext } from "@jarvis/core";
import { computeParamsHash } from "@jarvis/core";

// ---------------------------------------------------------------------------
// Phase 19.1 — proof that the executor authorized THIS call.
//
// A tool's `execute(params, context)` is a public method, and a context is a
// plain object anyone can build. `context.approvalId` therefore says only that
// the caller CLAIMS an approval; it does not say that the executor checked
// permissions, refused a spoken turn, asked the shared-connection gate and
// bound the approval to these parameters. A browser write that trusted the
// field alone could be reached around all of that — by an agent holding the
// raw registry, by a test, by any in-process caller.
//
// The grant is what the executor alone can give. It is a record held in a
// module-private WeakMap, keyed by the exact context object the executor
// created and handed to the tool, written only after every check passed and
// immediately before `tool.execute`. A caller-built context, a copy of one, a
// spread of one, or one that carries a forged field has no entry. A grant is
// spent by its first read, and it names the tool, the user, the parameters'
// hash and the approval, so it cannot be carried to another call.
//
// This module is NOT exported from the package index, and the package exports
// nothing but its index, so code outside `@jarvis/tools` cannot import it.
// Within the package only the executor issues a grant, and a grant is read
// only through `verifyExecutionGrant` — the browser writes and the Meta Ads
// writes, as their first step (both pinned by tests).
// ---------------------------------------------------------------------------

export interface ExecutionGrant {
  /** The registry id of the tool the executor ran. */
  readonly toolId: string;
  readonly userId: string;
  /** `computeParamsHash` of the parameters the executor validated and bound. */
  readonly paramsHash: string;
  /** The approval the executor found approved, unexpired and bound. */
  readonly approvalId: string;
  readonly inputMode?: InputMode;
  /** True when the executor asked its shared-connection gate and was allowed. */
  readonly sharedAccessChecked: boolean;
}

const grants = new WeakMap<object, ExecutionGrant>();

/** Executor only: record that this context's call passed every check. */
export function issueExecutionGrant(context: ToolContext, grant: ExecutionGrant): void {
  grants.set(context, Object.freeze({ ...grant }));
}

/** Read the grant for this context and spend it: a second read finds none. */
function takeExecutionGrant(context: ToolContext): ExecutionGrant | undefined {
  const grant = grants.get(context);
  grants.delete(context);
  return grant;
}

/** Why a call was refused. Each tool words it in its own sentence. */
export type ExecutionGrantRefusal = "spoken" | "not_authorized";

/**
 * Did the executor authorize THIS call? The first step of every sensitive
 * write, before it reads, journals, resolves an Organization or spends an
 * approval.
 *
 * `context.approvalId` alone proves nothing: anyone holding the tool can build
 * a context. What proves it is the executor's grant for this exact context
 * object, naming this tool, this user, these parameters and this approval,
 * issued only after the executor checked permissions, refused a spoken turn,
 * asked its shared-connection gate and found the approval approved, unexpired
 * and bound. The grant is spent here, so it cannot be used twice. A spoken
 * turn is refused again on both the grant and the context, behind the
 * executor's own refusal.
 *
 * The approval itself is still spent by the approval store, which checks it
 * again: this answers only whether the executor's checks ran.
 */
export function verifyExecutionGrant(
  toolId: string,
  params: Record<string, unknown>,
  context: ToolContext
): { ok: true } | { ok: false; refusal: ExecutionGrantRefusal } {
  const grant = takeExecutionGrant(context);
  if (grant?.inputMode === "voice" || context.inputMode === "voice") {
    return { ok: false, refusal: "spoken" };
  }
  if (
    !grant ||
    grant.toolId !== toolId ||
    grant.userId !== context.userId ||
    !grant.approvalId ||
    grant.approvalId !== context.approvalId ||
    grant.paramsHash !== computeParamsHash(params) ||
    !grant.sharedAccessChecked
  ) {
    return { ok: false, refusal: "not_authorized" };
  }
  return { ok: true };
}
