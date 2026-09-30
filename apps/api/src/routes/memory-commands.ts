// ---------------------------------------------------------------------------
// S7.2 L5 — one chat turn that is a memory command.
//
// Called by the chat route after the pending-action branches and before the
// work and orchestrator paths. It returns null — having done NOTHING, not even
// saved the message — whenever the turn is not a memory command it can act
// on, so the message flows on exactly as before.
//
// Nothing here deletes. A deletion is always:
//   resolve the target to ids from something the user was shown or said
//   → show it → a HIGH_IMPACT pending action (Approval row, ids + versions)
//   → the user confirms (typed "yes", or the on-screen button; never voice)
//   → ToolExecutor runs memory.forget / memory.forget_all.
// Targets are never memory text, never a similarity search.
// ---------------------------------------------------------------------------

import type { ConversationMessage, IntentResult, MemoryCommand, MemoryView, PendingAction } from "@jarvis/core";
import {
  MEMORY_FORGET_LIMIT,
  MEMORY_STRICT_CONFIRMATION,
  MEMORY_TOOL_IDS,
  isDestructiveMemoryTool,
  isStrictMemoryConfirmation,
  memoryToolConfirmation,
} from "@jarvis/core";
import type { PendingActionService } from "@jarvis/agents";
import type { MemoryManagementService } from "@jarvis/memory";

/** What a memory turn may do: read, and set the learning controls. It cannot delete. */
export type MemoryCommandPort = Pick<
  MemoryManagementService,
  "list" | "views" | "fromSourceMessage" | "count" | "vetoSource" | "pauseLearning" | "resumeLearning" | "learningControl" | "recordCommand"
>;

export interface MemoryTurn {
  reply: string;
  /** Stored on the assistant message, e.g. the numbering of a list shown. */
  metadata: Record<string, unknown>;
  /** The standard pending-action shape: the card and the voice guard read it. */
  pendingAction?: Record<string, unknown>;
}

interface Context {
  command: MemoryCommand;
  userId: string;
  conversationId: string;
  /** This conversation's messages BEFORE this turn. */
  history: ConversationMessage[];
  pendingActionActive: boolean;
  memories: MemoryCommandPort;
  pendingActions?: Pick<PendingActionService, "createPendingAction">;
  saveUserMessage: () => Promise<unknown>;
}

const SELECTION_HINT = "To forget one, say “forget 2” (or “forget 1 and 3”).";

// ---------------------------------------------------------------------------
// Reading what the conversation already holds — server-written metadata only
// ---------------------------------------------------------------------------

function last(history: ConversationMessage[], role: "user" | "assistant"): ConversationMessage | undefined {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.role === role) return history[i];
  return undefined;
}

/** The numbering of the memories the last reply showed, if it showed any. */
function selectionOf(message: ConversationMessage | undefined): Array<{ id: string; version: string }> | null {
  const selection = (message?.metadata as Record<string, unknown> | undefined)?.memorySelection;
  if (!Array.isArray(selection)) return null;
  const valid = selection.filter(
    (s): s is { id: string; version: string } => typeof s === "object" && s !== null && typeof s.id === "string" && typeof s.version === "string"
  );
  return valid.length === selection.length ? valid : null;
}

/** The memories the last reply was built on (the orchestrator's recalledMemoryIds). */
function recalledOf(message: ConversationMessage | undefined): string[] {
  const model = (message?.metadata as Record<string, unknown> | undefined)?.model as Record<string, unknown> | undefined;
  const ids = model?.recalledMemoryIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function numbered(views: MemoryView[]): string[] {
  return views.map((v, i) => `${i + 1}. ${v.content}${v.legacy ? " (older memory)" : ""}`);
}

function selectionMetadata(views: MemoryView[]): Record<string, unknown> {
  return { memorySelection: views.map((v) => ({ id: v.id, version: v.changedAt })) };
}

function pendingShape(pending: PendingAction, summary: string): Record<string, unknown> {
  return {
    id: pending.id,
    toolId: pending.toolId,
    action: pending.action,
    params: pending.params,
    riskLevel: pending.riskLevel,
    state: pending.state,
    approvalId: pending.approvalId,
    expiresAt: pending.expiresAt,
    summary,
  };
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export async function handleMemoryCommand(ctx: Context): Promise<MemoryTurn | null> {
  const { command, userId, memories } = ctx;
  if (command.kind === "NONE" || command.kind === "REPLACE") return null; // a new value is learned by L1 → L4

  // Resolution first — read-only — so a turn this path does not own falls
  // through with nothing saved and nothing changed.
  const lastReply = last(ctx.history, "assistant");
  let targets: MemoryView[] | null = null;

  if (command.kind === "FORGET" && command.target.kind === "SELECTION") {
    const selection = selectionOf(lastReply);
    if (!selection) return null; // "forget 2" with no list shown is not about memories
    if (!ctx.pendingActionActive) {
      if (command.target.positions.some((p) => p > selection.length)) {
        await ctx.saveUserMessage();
        await memories.recordCommand(userId, command.kind, "AMBIGUOUS", 0);
        return { reply: `I only showed ${selection.length} ${selection.length === 1 ? "memory" : "memories"}. ${SELECTION_HINT}`, metadata: {} };
      }
      targets = await memories.views(userId, command.target.positions.map((p) => selection[p - 1]!.id));
    }
  }

  if (command.kind === "CORRECT" && !ctx.pendingActionActive) {
    const shown = selectionOf(lastReply);
    const ids = shown && shown.length === 1 ? [shown[0]!.id] : recalledOf(lastReply);
    targets = await memories.views(userId, ids);
    if (targets.length === 0) return null; // no memory behind the last reply: ordinary conversation
  }

  await ctx.saveUserMessage();

  if (ctx.pendingActionActive && command.kind !== "LIST" && command.kind !== "LEARNING_PAUSE" && command.kind !== "LEARNING_RESUME" && command.kind !== "VETO") {
    await memories.recordCommand(userId, command.kind, "BLOCKED_BY_PENDING_ACTION", 0);
    return { reply: "There's an action waiting for your confirmation. Please confirm or cancel it first, then ask me again.", metadata: {} };
  }

  switch (command.kind) {
    case "LIST":
      return listTurn(ctx);

    case "LEARNING_PAUSE":
      await memories.pauseLearning(userId);
      return {
        reply: "Okay — I've stopped learning new things about you. What I already remember stays; say “show my memories” to see it, or “start remembering again” to turn learning back on.",
        metadata: {},
      };

    case "LEARNING_RESUME":
      await memories.resumeLearning(userId);
      return { reply: "Okay — I'll learn from what you tell me again.", metadata: {} };

    case "VETO":
      return vetoTurn(ctx);

    case "FORGET_ALL":
      return forgetAllTurn(ctx, command.scope);

    case "CORRECT":
      if (targets!.length > 1) {
        await memories.recordCommand(userId, command.kind, "AMBIGUOUS", targets!.length);
        return {
          reply: ["My last answer used these memories:", ...numbered(targets!), "", `Which one is wrong? ${SELECTION_HINT}`].join("\n"),
          metadata: selectionMetadata(targets!),
        };
      }
      return propose(ctx, targets!);

    case "FORGET": {
      if (command.target.kind === "SELECTION") {
        if (targets!.length === 0) {
          await memories.recordCommand(userId, command.kind, "NOT_FOUND", 0);
          return { reply: "Those memories no longer exist, so there's nothing to forget.", metadata: {} };
        }
        return propose(ctx, targets!);
      }
      const referent = await thisMemory(ctx, lastReply);
      if (referent.length === 0) {
        await memories.recordCommand(userId, command.kind, "AMBIGUOUS", 0);
        return { reply: `I'm not sure which memory you mean. Say “show my memories” first. ${SELECTION_HINT}`, metadata: {} };
      }
      return propose(ctx, referent);
    }
  }
}

/** "this memory": the one just shown, else what the user's last message taught, else the one memory the last reply used. */
async function thisMemory(ctx: Context, lastReply: ConversationMessage | undefined): Promise<MemoryView[]> {
  const shown = selectionOf(lastReply);
  if (shown && shown.length === 1) return ctx.memories.views(ctx.userId, [shown[0]!.id]);
  const statement = last(ctx.history, "user");
  if (statement) {
    const taught = await ctx.memories.fromSourceMessage(ctx.userId, statement.id);
    if (taught.length > 0) return taught;
  }
  const recalled = recalledOf(lastReply);
  return recalled.length === 1 ? ctx.memories.views(ctx.userId, recalled) : [];
}

async function listTurn(ctx: Context): Promise<MemoryTurn> {
  const [{ memories: views, total }, control] = await Promise.all([ctx.memories.list(ctx.userId, { limit: MEMORY_FORGET_LIMIT }), ctx.memories.learningControl(ctx.userId)]);
  const paused = control.learningPaused ? "\n\nLearning is paused — say “start remembering again” to turn it back on." : "";
  if (views.length === 0) return { reply: `I don't have any memories about you yet.${paused}`, metadata: {} };
  const more = total > views.length ? `\nShowing the newest ${views.length} of ${total}.` : "";
  return {
    reply: [
      "Here's what I remember about you:",
      ...numbered(views),
      more,
      `${SELECTION_HINT} To forget everything, say “forget everything you remember about me”.${paused}`,
    ]
      .filter((line) => line !== "")
      .join("\n"),
    metadata: selectionMetadata(views),
  };
}

async function vetoTurn(ctx: Context): Promise<MemoryTurn> {
  const statement = last(ctx.history, "user");
  if (!statement) return { reply: "There's nothing earlier in this conversation for me to forget.", metadata: {} };

  // The veto first, then the lookup: extraction that finishes after this
  // point is blocked, and anything it finished before is found below.
  await ctx.memories.vetoSource(ctx.userId, statement.id);
  const taught = ctx.pendingActionActive ? [] : await ctx.memories.fromSourceMessage(ctx.userId, statement.id);
  if (taught.length === 0) {
    const waiting = ctx.pendingActionActive ? " There's also an action waiting for your confirmation." : "";
    return { reply: `Okay — I won't remember what you just said.${waiting}`, metadata: {} };
  }
  return propose(ctx, taught, "Okay — I won't learn anything more from what you just said. I had already saved this from it:");
}

async function forgetAllTurn(ctx: Context, scope: "ALL" | "LEGACY"): Promise<MemoryTurn> {
  const count = await ctx.memories.count(ctx.userId, scope);
  if (count === 0) {
    await ctx.memories.recordCommand(ctx.userId, "FORGET_ALL", "NOTHING_TO_FORGET", 0);
    return { reply: "There's nothing to forget.", metadata: {} };
  }
  if (!ctx.pendingActions) return unavailable(ctx, "FORGET_ALL");
  const what = scope === "ALL" ? `all ${count} ${count === 1 ? "memory" : "memories"} I have about you` : `the ${count} older ${count === 1 ? "memory" : "memories"} from before memory checks`;
  const reply = [
    `This will permanently forget ${what}. Your conversations, documents and settings are not affected.`,
    "",
    `To confirm, type “${MEMORY_STRICT_CONFIRMATION}” or press Confirm. To keep them, say “no”. Voice can't confirm this.`,
  ].join("\n");
  const { pendingAction } = await ctx.pendingActions.createPendingAction({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    toolId: MEMORY_TOOL_IDS.forgetAll,
    action: scope === "ALL" ? "Forget all memories" : "Forget older memories",
    params: { scope },
    riskLevel: "HIGH_IMPACT",
  });
  await ctx.memories.recordCommand(ctx.userId, "FORGET_ALL", "PROPOSED", count);
  return { reply, metadata: {}, pendingAction: pendingShape(pendingAction, reply) };
}

/** A HIGH_IMPACT pending action for exactly these memories, at exactly these versions. */
async function propose(ctx: Context, views: MemoryView[], lead?: string): Promise<MemoryTurn> {
  if (!ctx.pendingActions) return unavailable(ctx, ctx.command.kind);
  const chosen = views.slice(0, MEMORY_FORGET_LIMIT);
  const n = chosen.length;
  const reply = [
    lead ?? (n === 1 ? "I'll forget this memory:" : `I'll forget these ${n} memories:`),
    ...numbered(chosen),
    "",
    "Reply “yes” to forget it, or “no” to keep it. (With voice, use the on-screen buttons — voice can't confirm this.)",
  ].join("\n");
  const { pendingAction } = await ctx.pendingActions.createPendingAction({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    toolId: MEMORY_TOOL_IDS.forget,
    action: n === 1 ? "Forget 1 memory" : `Forget ${n} memories`,
    params: { memoryIds: chosen.map((v) => v.id), versions: chosen.map((v) => v.changedAt) },
    riskLevel: "HIGH_IMPACT",
  });
  await ctx.memories.recordCommand(ctx.userId, ctx.command.kind, "PROPOSED", n);
  return { reply, metadata: {}, pendingAction: pendingShape(pendingAction, reply) };
}

async function unavailable(ctx: Context, kind: string): Promise<MemoryTurn> {
  await ctx.memories.recordCommand(ctx.userId, kind, "CONFIRMATION_UNAVAILABLE", 0);
  return { reply: "I can't forget memories here: confirmations aren't available on this server.", metadata: {} };
}

// ---------------------------------------------------------------------------
// Confirming a memory action
// ---------------------------------------------------------------------------

/**
 * Applied to a reply while a pending action is active. For a memory action:
 *   - a forget-all (STRICT) is confirmed in writing only by the exact phrase —
 *     a stray "great" or "yes" never wipes every memory;
 *   - a memory action is never modified: it names exactly what was shown.
 * Every other action passes through untouched.
 */
export function guardMemoryConfirmation(message: string, pending: PendingAction, intent: IntentResult): { intent: IntentResult } | { reply: string } {
  if (!isDestructiveMemoryTool(pending.toolId)) return { intent };
  if (memoryToolConfirmation(pending.toolId) === "STRICT") {
    if (isStrictMemoryConfirmation(message)) return { intent: { type: "CONFIRM", confidence: 1 } };
    if (intent.type === "CONFIRM") {
      return { reply: `To forget everything, type exactly “${MEMORY_STRICT_CONFIRMATION}” or press Confirm. Nothing has been forgotten yet.` };
    }
  }
  if (intent.type === "MODIFY") return { reply: "A memory action can't be changed. Say “no” to cancel it, then ask me again." };
  return { intent };
}
