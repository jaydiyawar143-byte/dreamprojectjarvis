// ---------------------------------------------------------------------------
// TaskPlannerService — Task Planner V1.
//
//   task title + description  ->  ONE proposed tool call  ->  (nothing runs)
//
// This closes the gap Task Execution V1 left open: `executeTask` needs a
// `toolId` and `params`, and until now a human had to supply them. The planner
// proposes them. It does not run them, does not touch task status, and does
// not decide whether it is ALLOWED to run them.
//
// THE MODEL IS A CHOOSER, NEVER AN AUTHORITY.
//
// It receives a catalogue of tools the caller may already use and picks one
// from it. Everything after that is deterministic and server-side:
//
//   1. the output is parsed as JSON and validated by a `.strict()` schema
//   2. the chosen id must be in the SAME allowlist TaskExecutionService uses
//   3. the tool must exist and be enabled in the real ToolRegistry
//   4. the params must pass the tool's own validation
//
// A tool name that the model invented cannot survive step 2, which is the
// repository's standing rule — `recommendation-bridge.ts`: "tool names NEVER
// derive from data" — applied to model output rather than to a stored row.
// Step 3 and 4 reuse `ToolPlanValidator`, the validator the agent layer
// already uses for exactly this, so there is one implementation of "is this
// step runnable" rather than two.
//
// WHAT A PLAN IS NOT. It is not permission. `executeTask` re-checks the
// allowlist, and `ToolExecutor` still performs the permission check and the
// approval gate on the way through. A plan for an approval-gated tool
// produces an approval, exactly as the same call typed by hand would.
//
// ONE ACTION ONLY. The schema below holds a single `toolId`, so a chain is not
// expressible — the model cannot return one even if it wants to. A goal that
// genuinely needs several steps comes back `executable: false` with a reason
// that says so.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { IAIProvider, ITool, ToolPlan } from "@jarvis/core";
import { ToolPlanValidator } from "@jarvis/agents";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface TaskPlanInput {
  userId: string;
  taskId: string;
  title: string;
  description?: string | null;
  traceId?: string;
}

export type TaskPlan =
  | {
      executable: true;
      toolId: string;
      params: Record<string, unknown>;
      /** Why this tool, in the user's terms. Safe to show. */
      reason: string;
    }
  | {
      executable: false;
      reason: string;
    };

/** The narrow view of a tool the model is allowed to see. */
interface PlannableTool {
  toolId: string;
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
  }>;
}

export interface TaskPlannerDeps {
  provider: IAIProvider;
  /** The real registry. Narrowed here so the planner cannot execute anything. */
  registry: { get(toolId: string): ITool | undefined; getAll(): ITool[] };
  /**
   * The SAME set TaskExecutionService validates against.
   *
   * Sharing it is the point: a plan the planner produces is a plan the
   * executor will still accept, and a tool neither will run is invisible to
   * the model in the first place.
   */
  allowedToolIds: ReadonlySet<string>;
  /** Overridable for tests; defaults to the real one. */
  validator?: ToolPlanValidator;
}

// ---------------------------------------------------------------------------
// Model output — strict, so anything unexpected is a refusal rather than a guess
// ---------------------------------------------------------------------------

const PlannerOutputSchema = z
  .object({
    executable: z.boolean(),
    /** Present only when executable. Validated against the registry below. */
    toolId: z.string().min(1).max(120).optional(),
    params: z.record(z.unknown()).optional(),
    reason: z.string().min(1).max(600),
    /** The model's own signal that one call is not enough. */
    requiresMultipleActions: z.boolean().optional(),
  })
  .strict();

const MAX_REASON = 400;
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 2000;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Pulls the JSON object out of a completion.
 *
 * Same shape as `extractJson` in the diagnosis engine, and deliberately as
 * unforgiving: a fenced block or a bare object, and nothing else. Prose that
 * merely mentions a tool is not a plan.
 */
function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no_json_object");
  return JSON.parse(candidate.slice(start, end + 1));
}

const MALFORMED = "Planner produced invalid structured output.";
const MULTI_STEP =
  "This goal requires multiple actions; multi-step planning is not supported in V1.";
const NO_CAPABILITY = "No authorized executable capability is available for this task.";

// ---------------------------------------------------------------------------

export class TaskPlannerService {
  private readonly validator: ToolPlanValidator;

  constructor(private readonly deps: TaskPlannerDeps) {
    this.validator = deps.validator ?? new ToolPlanValidator();
  }

  /**
   * Propose ONE tool call for a task, or explain why there isn't one.
   *
   * Never throws for a planning failure: an unusable model, a malformed
   * answer and an impossible goal are all ordinary outcomes that come back as
   * `executable: false`. Nothing here writes, and nothing here runs.
   */
  async planTask(input: TaskPlanInput): Promise<TaskPlan> {
    const catalogue = this.catalogue();
    if (catalogue.length === 0) {
      return { executable: false, reason: NO_CAPABILITY };
    }

    let content: string;
    try {
      const response = await this.deps.provider.complete({
        messages: [
          { role: "system", content: this.systemPrompt(catalogue) },
          { role: "user", content: this.userPrompt(input) },
        ],
        temperature: 0,
        ...(input.traceId ? { traceId: input.traceId } : {}),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      content = response.message.content ?? "";
    } catch {
      // A provider that is down, rate-limited or unconfigured is not a plan.
      // The message is deliberately generic: provider error text is an
      // internal detail and must not reach the user.
      return { executable: false, reason: "The planner is unavailable right now." };
    }

    let parsed: z.infer<typeof PlannerOutputSchema>;
    try {
      const result = PlannerOutputSchema.safeParse(extractJson(content));
      if (!result.success) return { executable: false, reason: MALFORMED };
      parsed = result.data;
    } catch {
      return { executable: false, reason: MALFORMED };
    }

    // The model said so itself.
    if (parsed.requiresMultipleActions === true) {
      return { executable: false, reason: MULTI_STEP };
    }

    if (!parsed.executable) {
      return { executable: false, reason: this.trim(parsed.reason) };
    }

    // Declared executable but named nothing: malformed, not "try anyway".
    if (!parsed.toolId) {
      return { executable: false, reason: MALFORMED };
    }

    return this.validateProposal(parsed.toolId, parsed.params ?? {}, this.trim(parsed.reason));
  }

  // -------------------------------------------------------------------------

  /**
   * The deterministic half. Nothing the model said is trusted past this point.
   */
  private validateProposal(
    toolId: string,
    params: Record<string, unknown>,
    reason: string
  ): TaskPlan {
    // 1. The allowlist. An invented id dies here, and so does a real tool that
    //    no agent policy grants — the same boundary TaskExecutionService
    //    enforces, checked twice on purpose.
    if (!this.deps.allowedToolIds.has(toolId)) {
      return { executable: false, reason: NO_CAPABILITY };
    }

    // 2. The real registry. Allowed but unregistered on this deployment means
    //    there is nothing to run.
    const tool = this.deps.registry.get(toolId);
    if (!tool || !tool.enabled) {
      return { executable: false, reason: NO_CAPABILITY };
    }

    // 3. The tool's own parameter validation, through the validator the agent
    //    layer already uses. A single-step plan, because one action is the
    //    whole contract — the validator's chain and cycle checks are inert
    //    here by construction.
    const plan: ToolPlan = {
      intent: "task.plan",
      requiresTools: true,
      steps: [{ tool: toolId, params }],
    };
    const validated = this.validator.validate(plan, [tool]);
    if (!validated.valid) {
      return {
        executable: false,
        // The validator's messages name the tool and the failure, which is
        // what a user needs; they carry no provider or credential detail.
        reason: `The proposed action is not valid: ${validated.errors.join("; ")}`,
      };
    }

    return { executable: true, toolId, params, reason };
  }

  /**
   * What the model may see.
   *
   * Intersection of "registered here" and "some agent policy grants it". Each
   * entry is id, name, description and parameter shape — the same projection
   * the orchestrator already hands a model. No risk level, no permissions, no
   * environment, no provider configuration, no credential: there is nothing
   * in this object that is not already visible in a tool result.
   */
  private catalogue(): PlannableTool[] {
    return this.deps.registry
      .getAll()
      .filter((tool) => tool.enabled && this.deps.allowedToolIds.has(tool.id))
      .map((tool) => ({
        toolId: tool.id,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters.map((p) => ({
          name: p.name,
          type: String(p.type),
          description: p.description,
          required: p.required === true,
        })),
      }));
  }

  private systemPrompt(catalogue: PlannableTool[]): string {
    return [
      "You choose ONE tool call that would accomplish a task, or report that none would.",
      "",
      "Answer with a single JSON object and nothing else. No prose, no explanation outside it.",
      "",
      "Shape:",
      '{"executable":true,"toolId":"<id from the list>","params":{...},"reason":"<one sentence>"}',
      'or {"executable":false,"reason":"<one sentence>"}',
      'or {"executable":false,"requiresMultipleActions":true,"reason":"<one sentence>"}',
      "",
      "Rules:",
      "- `toolId` MUST be copied exactly from the list below. Never invent one.",
      "- Exactly one tool call. If the task needs several, set requiresMultipleActions to true.",
      "- If no listed tool accomplishes the task, set executable to false. Do not approximate.",
      "- Include every required parameter. Never guess a value you were not given —",
      "  if a required value is missing from the task, set executable to false instead.",
      "- `reason` is shown to the user. Keep it to one plain sentence.",
      "",
      "Available tools:",
      JSON.stringify(catalogue),
    ].join("\n");
  }

  private userPrompt(input: TaskPlanInput): string {
    const description = input.description?.trim();
    return [
      "Task title:",
      input.title.slice(0, MAX_TITLE),
      ...(description ? ["", "Task description:", description.slice(0, MAX_DESCRIPTION)] : []),
    ].join("\n");
  }

  private trim(reason: string): string {
    return reason.trim().slice(0, MAX_REASON);
  }
}
