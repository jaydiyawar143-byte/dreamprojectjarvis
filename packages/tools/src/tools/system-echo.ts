import { BaseTool } from "../base-tool.js";
import type { ToolResult } from "@jarvis/core";

export class SystemEchoTool extends BaseTool {
  constructor() {
    super(
      "system.echo",
      "System Echo",
      "Echoes the input message back. Harmless test tool.",
      "system",
      [
        {
          name: "message",
          type: "string",
          description: "Message to echo back",
          required: true,
        },
      ],
      false,
      ["read"]
    );
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const message = params.message;
    if (typeof message !== "string") {
      return this.failure("message must be a string");
    }
    return this.success({ message });
  }
}
