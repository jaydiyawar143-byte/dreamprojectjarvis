import { describe, it, expect, beforeEach } from "vitest";
import {
  sanitizeToolResult,
  wrapToolResult,
  validateToolResultSchema,
  sanitizeOutputForModel,
} from "../src/output-sanitizer.js";
import type { ToolResult } from "@jarvis/core";

describe("Output Sanitizer", () => {
  describe("sanitizeToolResult", () => {
    it("passes through clean results unchanged", () => {
      const result: ToolResult = {
        success: true,
        data: { message: "hello world" },
      };
      const sanitized = sanitizeToolResult(result);
      expect(sanitized.result).toEqual(result);
      expect(sanitized.truncated).toBe(false);
      expect(sanitized.redacted).toBe(false);
    });

    it("redacts OpenAI API keys", () => {
      const result: ToolResult = {
        success: true,
        data: { key: "sk-abc123def456ghi789jkl012" },
      };
      const sanitized = sanitizeToolResult(result);
      expect(sanitized.redacted).toBe(true);
      const data = sanitized.result.data as { key: string };
      expect(data.key).toBe("[REDACTED]");
    });

    it("redacts bearer tokens in strings", () => {
      const result: ToolResult = {
        success: true,
        data: { auth: "Bearer secrettoken123456" },
      };
      const sanitized = sanitizeToolResult(result);
      expect(sanitized.redacted).toBe(true);
      const data = sanitized.result.data as { auth: string };
      expect(data.auth).toContain("[REDACTED]");
    });

    it("redacts api key patterns", () => {
      const result: ToolResult = {
        success: true,
        data: { config: "api_key: abcdef123456" },
      };
      const sanitized = sanitizeToolResult(result);
      expect(sanitized.redacted).toBe(true);
    });

    it("redacts password patterns", () => {
      const result: ToolResult = {
        success: true,
        data: { config: "password: mysecretpassword" },
      };
      const sanitized = sanitizeToolResult(result);
      expect(sanitized.redacted).toBe(true);
    });

    it("truncates long strings", () => {
      const result: ToolResult = {
        success: true,
        data: { content: "a".repeat(60000) },
      };
      const sanitized = sanitizeToolResult(result, { maxStringLength: 50000 });
      expect(sanitized.truncated).toBe(true);
      const data = sanitized.result.data as { content: string };
      expect(data.content.length).toBeLessThan(60000);
      expect(data.content).toContain("[...truncated]");
    });

    it("truncates long strings in nested objects", () => {
      const result: ToolResult = {
        success: true,
        data: { items: Array.from({ length: 100 }, (_, i) => `item-${i}-` + "x".repeat(600)) },
      };
      const sanitized = sanitizeToolResult(result, { maxStringLength: 100 });
      expect(sanitized.truncated).toBe(true);
    });

    it("returns error when result exceeds max size", () => {
      const result: ToolResult = {
        success: true,
        data: { content: "x".repeat(200_000) },
      };
      const sanitized = sanitizeToolResult(result, { maxResultSizeBytes: 1000 });
      expect(sanitized.result.success).toBe(false);
      expect(sanitized.result.error).toContain("too large");
    });

    it("handles results with no data", () => {
      const result: ToolResult = { success: true };
      const sanitized = sanitizeToolResult(result);
      expect(sanitized.result).toEqual(result);
    });

    it("handles results with only error", () => {
      const result: ToolResult = { success: false, error: "Something went wrong" };
      const sanitized = sanitizeToolResult(result);
      expect(sanitized.result.error).toBe("Something went wrong");
    });

    it("handles nested objects with secrets", () => {
      const result: ToolResult = {
        success: true,
        data: {
          nested: {
            deep: {
              secret: "sk-abc123def456ghi789jkl012",
            },
          },
        },
      };
      const sanitized = sanitizeToolResult(result);
      expect(sanitized.redacted).toBe(true);
      const data = sanitized.result.data as { nested: { deep: { secret: string } } };
      expect(data.nested.deep.secret).toBe("[REDACTED]");
    });

    it("handles arrays with secrets", () => {
      const result: ToolResult = {
        success: true,
        data: { tokens: ["sk-abc123def456ghi789jkl012", "normal-value"] },
      };
      const sanitized = sanitizeToolResult(result);
      expect(sanitized.redacted).toBe(true);
      const data = sanitized.result.data as { tokens: string[] };
      expect(data.tokens[0]).toBe("[REDACTED]");
      expect(data.tokens[1]).toBe("normal-value");
    });

    it("does not redact when redactSecrets is false", () => {
      const result: ToolResult = {
        success: true,
        data: { key: "sk-abc123def456ghi789jkl012" },
      };
      const sanitized = sanitizeToolResult(result, { redactSecrets: false });
      expect(sanitized.redacted).toBe(false);
      const data = sanitized.result.data as { key: string };
      expect(data.key).toBe("sk-abc123def456ghi789jkl012");
    });
  });

  describe("wrapToolResult", () => {
    it("wraps result in tool_result tags", () => {
      const result: ToolResult = { success: true, data: { msg: "hi" } };
      const wrapped = wrapToolResult(result);
      expect(wrapped.startsWith("<tool_result>")).toBe(true);
      expect(wrapped.endsWith("</tool_result>")).toBe(true);
      expect(wrapped).toContain(JSON.stringify(result));
    });

    it("wraps error results", () => {
      const result: ToolResult = { success: false, error: "fail" };
      const wrapped = wrapToolResult(result);
      expect(wrapped).toContain("<tool_result>");
      expect(wrapped).toContain("fail");
    });
  });

  describe("validateToolResultSchema", () => {
    it("validates correct ToolResult", () => {
      const result = validateToolResultSchema({ success: true, data: "test" });
      expect(result.success).toBe(true);
    });

    it("throws on invalid ToolResult", () => {
      expect(() => validateToolResultSchema({ invalid: true })).toThrow();
    });

    it("accepts minimal ToolResult", () => {
      const result = validateToolResultSchema({ success: false });
      expect(result.success).toBe(false);
    });
  });

  describe("sanitizeOutputForModel", () => {
    it("sanitizes and wraps in one step", () => {
      const result: ToolResult = {
        success: true,
        data: { key: "sk-test123abc456def789ghi012" },
      };
      const output = sanitizeOutputForModel(result);
      expect(output).toContain("<tool_result>");
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("sk-test123");
    });

    it("returns wrapped clean data", () => {
      const result: ToolResult = { success: true, data: "clean" };
      const output = sanitizeOutputForModel(result);
      expect(output).toContain("<tool_result>");
      expect(output).toContain("clean");
    });
  });

  describe("no secret leakage", () => {
    it("never leaks secrets in any field", () => {
      const secrets = [
        "sk-abcdefghijklmnopqrstuvwxyz",
        "api_key: supersecretkey123456",
        "Bearer eyJhbGciOiJIUzI1NiJ9",
        "password: hunter2",
        "token: abcdef1234567890",
        "secret: my-secret-value",
      ];

      for (const secret of secrets) {
        const result: ToolResult = { success: true, data: { value: secret } };
        const sanitized = sanitizeToolResult(result);
        const json = JSON.stringify(sanitized.result);
        expect(json).not.toContain(secret);
        expect(json).toContain("[REDACTED]");
      }
    });
  });
});
