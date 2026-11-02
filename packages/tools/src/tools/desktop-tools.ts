// ---------------------------------------------------------------------------
// Phase 19.7 — the two desktop actions a model may propose.
//
// One port and nothing else: no signing, no device, no grant, no store. All of
// that is the desktop service's (the integration rule), so the Computer Control
// page and chat are the same path. A model's parameters are `app` or `text`;
// the device is added by the server when it accepts the proposal, so a call
// without one never went through it.
//
// Both tools stop at an approval. Running needs the executor's grant, like a
// browser write, and an uncertain outcome is reported as uncertain: the tool
// holds nothing that could send it again.
// ---------------------------------------------------------------------------

import { BaseTool } from "../base-tool.js";
import { verifyExecutionGrant } from "../execution-grant.js";
import type { DesktopChatPort, DesktopChatToolId, ToolContext, ToolParameter, ToolResult } from "@jarvis/core";
import { DESKTOP_APP_IDS, parseComputerControlRequest, voiceToolRefusal } from "@jarvis/core";

/** The one answer to a desktop action that did not come through the executor's checks. */
const DESKTOP_NOT_AUTHORIZED = "Desktop actions run only after an approval is checked, so nothing was done.";

abstract class DesktopChatTool extends BaseTool {
  constructor(
    readonly action: DesktopChatToolId,
    name: string,
    description: string,
    parameters: ToolParameter[],
    private readonly port: Pick<DesktopChatPort, "runApproved">
  ) {
    super(action, name, description, "system", parameters, true, ["read", "write"], "EXTERNAL_SIDE_EFFECT");
  }

  override validate(params: Record<string, unknown>): boolean {
    if (!super.validate(params) || typeof params.deviceId !== "string") return false;
    return parseComputerControlRequest({ ...params, action: this.id }).ok;
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const verdict = verifyExecutionGrant(this.id, params, context);
    if (!verdict.ok) {
      return this.failure(verdict.refusal === "spoken" ? (voiceToolRefusal(this.id, "voice") ?? DESKTOP_NOT_AUTHORIZED) : DESKTOP_NOT_AUTHORIZED);
    }
    const report = await this.port.runApproved({
      userId: context.userId,
      action: this.action,
      params,
      approvalId: context.approvalId!,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const data = { outcome: report.outcome, message: report.message, ...(report.code ? { code: report.code } : {}) };
    // Only the computer's own "succeeded" is a success. Not sent, not done,
    // unknown and not answered yet are each said as what they are.
    return report.outcome === "succeeded" ? this.success(data) : { success: false, data, error: report.message };
  }
}

export class DesktopAppLaunchTool extends DesktopChatTool {
  constructor(port: Pick<DesktopChatPort, "runApproved">) {
    super(
      "desktop.app.launch",
      "Open an application",
      "Propose opening one approved application on the owner's paired Windows computer. It runs only after the owner approves it, and it types nothing.",
      [{ name: "app", type: "string", description: `Which application: exactly one of ${DESKTOP_APP_IDS.join(", ")}.`, required: true }],
      port
    );
  }
}

export class DesktopTypeTextTool extends DesktopChatTool {
  constructor(port: Pick<DesktopChatPort, "runApproved">) {
    super(
      "desktop.input.type",
      "Type text",
      "Propose typing exact text into the window that has focus on the owner's paired Windows computer. It runs only after the owner approves it and verifies with Windows Hello.",
      [{ name: "text", type: "string", description: "The exact text, word for word as the owner wrote it in their latest message. One line, no line breaks.", required: true }],
      port
    );
  }
}

export function createDesktopTools(port: Pick<DesktopChatPort, "runApproved">): BaseTool[] {
  return [new DesktopAppLaunchTool(port), new DesktopTypeTextTool(port)];
}
