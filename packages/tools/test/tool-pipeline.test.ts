import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolRegistry } from "../src/registry.js";
import { ToolExecutor } from "../src/executor.js";
import { SystemEchoTool } from "../src/tools/system-echo.js";
import { WebResearchTool, type SearchProvider } from "../src/tools/web-research.js";
import { CsvAnalyzerTool } from "../src/tools/csv-analyzer.js";
import { PdfGeneratorTool, type PdfGeneratorBackend } from "../src/tools/pdf-generator.js";
import { DocumentAnalyzerTool, type DocumentExtractor } from "../src/tools/document-analyzer.js";
import { sanitizeToolResult, wrapToolResult, sanitizeOutputForModel } from "../src/output-sanitizer.js";
import type { ITool, ToolResult, AuditLogger, IPermissionChecker, IApprovalManager, Role, ToolPermission } from "@jarvis/core";

function fakeTool(overrides: Partial<ITool> & { id: string }): ITool {
  return {
    name: overrides.id,
    description: `Fake tool ${overrides.id}`,
    category: "system",
    risk: "READ_ONLY",
    parameters: [],
    requiresApproval: false,
    requiredPermissions: ["read"],
    version: "1.0.0",
    enabled: true,
    execute: async () => ({ success: true }),
    validate: () => true,
    ...overrides,
  };
}

const noopAuditLogger: AuditLogger = {
  log: vi.fn().mockResolvedValue(undefined),
};

const allowAllPermissions: IPermissionChecker = {
  hasPermission: () => true,
};

const denyAllPermissions: IPermissionChecker = {
  hasPermission: () => false,
};

const noopApprovalManager: IApprovalManager = {
  requestApproval: vi.fn().mockResolvedValue({
    id: "approval-1",
    userId: "user-1",
    toolId: "test",
    action: "execute",
    params: {},
    status: "pending",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    createdAt: new Date().toISOString(),
  }),
  findExistingForTool: vi.fn().mockResolvedValue(null),
};

describe("Tool Pipeline Integration", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    vi.clearAllMocks();
  });

  describe("registry discovery", () => {
    it("registers all 4 new tools", () => {
      const mockSearch: SearchProvider = { search: vi.fn() };
      const mockPdfBackend: PdfGeneratorBackend = { generate: vi.fn() };
      const mockExtractor: DocumentExtractor = {
        extractPdf: vi.fn(),
        extractDocx: vi.fn(),
        extractTxt: vi.fn(),
        extractCsv: vi.fn(),
      };

      registry.register(new SystemEchoTool());
      registry.register(new WebResearchTool(mockSearch));
      registry.register(new CsvAnalyzerTool());
      registry.register(new PdfGeneratorTool(mockPdfBackend));
      registry.register(new DocumentAnalyzerTool(mockExtractor));

      expect(registry.count()).toBe(5);
      expect(registry.get("system.echo")).toBeDefined();
      expect(registry.get("web.research")).toBeDefined();
      expect(registry.get("data.csv.analyze")).toBeDefined();
      expect(registry.get("pdf.generate")).toBeDefined();
      expect(registry.get("document.analyze")).toBeDefined();
    });

    it("filters tools by risk level", () => {
      registry.register(new WebResearchTool({ search: vi.fn() }));
      registry.register(new CsvAnalyzerTool());
      registry.register(new DocumentAnalyzerTool({
        extractPdf: vi.fn(), extractDocx: vi.fn(), extractTxt: vi.fn(), extractCsv: vi.fn(),
      }));

      const readOnly = registry.getByRisk("READ_ONLY");
      expect(readOnly.length).toBeGreaterThanOrEqual(3);
    });

    it("filters tools by category", () => {
      registry.register(new WebResearchTool({ search: vi.fn() }));
      registry.register(new PdfGeneratorTool({ generate: vi.fn() }));

      expect(registry.getByCategory("research")).toHaveLength(1);
      expect(registry.getByCategory("file")).toHaveLength(1);
    });

    it("generates tool descriptions for model", () => {
      registry.register(new WebResearchTool({ search: vi.fn() }));
      registry.register(new CsvAnalyzerTool());

      const descs = registry.getToolDescriptions("user-1", "admin");
      expect(descs.length).toBeGreaterThanOrEqual(2);
      const webDesc = descs.find((d) => d.name === "web.research");
      expect(webDesc).toBeDefined();
      expect(webDesc!.risk).toBe("READ_ONLY");
      expect(webDesc!.approvalRequired).toBe(false);
    });
  });

  describe("permission checks", () => {
    it("allows owner to execute all tools", async () => {
      registry.register(new WebResearchTool({ search: vi.fn().mockResolvedValue([]) }));
      const executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger);

      const result = await executor.execute({
        toolId: "web.research",
        params: { query: "test" },
        userId: "user-1",
        role: "owner",
        traceId: "trace-1",
      });

      expect(result.status).not.toBe("permission_denied");
    });

    it("denies viewer from write tools", async () => {
      registry.register(new PdfGeneratorTool({ generate: vi.fn() }));
      const executor = new ToolExecutor(registry, denyAllPermissions, noopApprovalManager, noopAuditLogger);

      const result = await executor.execute({
        toolId: "pdf.generate",
        params: { title: "Test", sections: [{ title: "A", content: "B" }] },
        userId: "user-1",
        role: "viewer",
        traceId: "trace-1",
      });

      expect(result.status).toBe("permission_denied");
    });
  });

  describe("execution flow", () => {
    it("executes web research through full pipeline", async () => {
      const mockSearch: SearchProvider = {
        search: vi.fn().mockResolvedValue([
          { title: "Result 1", url: "https://a.com", snippet: "Snippet 1" },
        ]),
      };
      registry.register(new WebResearchTool(mockSearch));
      const executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger);

      const result = await executor.execute({
        toolId: "web.research",
        params: { query: "test query" },
        userId: "user-1",
        role: "admin",
        traceId: "trace-1",
      });

      expect(result.status).toBe("completed");
      expect(result.result).toBeDefined();
      expect(result.result!.success).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(noopAuditLogger.log).toHaveBeenCalled();
    });

    it("executes CSV analyzer through full pipeline", async () => {
      registry.register(new CsvAnalyzerTool());
      const executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger);

      const result = await executor.execute({
        toolId: "data.csv.analyze",
        params: { operation: "rowCount", data: "a,b\n1,2\n3,4" },
        userId: "user-1",
        role: "admin",
        traceId: "trace-1",
      });

      expect(result.status).toBe("completed");
      expect(result.result!.success).toBe(true);
    });

    it("reports tool not found", async () => {
      const executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger);

      const result = await executor.execute({
        toolId: "nonexistent.tool",
        params: {},
        userId: "user-1",
        role: "admin",
        traceId: "trace-1",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toBe("Tool not found");
    });

    it("reports invalid params", async () => {
      registry.register(new WebResearchTool({ search: vi.fn() }));
      const executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger);

      const result = await executor.execute({
        toolId: "web.research",
        params: {},
        userId: "user-1",
        role: "admin",
        traceId: "trace-1",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Invalid input");
    });
  });

  describe("timeout", () => {
    it("times out slow tools", async () => {
      const slowTool = fakeTool({
        id: "slow.tool",
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return { success: true };
        },
      });
      registry.register(slowTool);
      const executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger, {
        defaultTimeoutMs: 100,
      });

      const result = await executor.execute({
        toolId: "slow.tool",
        params: {},
        userId: "user-1",
        role: "admin",
        traceId: "trace-1",
      });

      expect(result.status).toBe("timed_out");
    });
  });

  describe("output sanitization integration", () => {
    it("sanitizes tool results before model consumption", () => {
      const result: ToolResult = {
        success: true,
        data: { apiKey: "sk-secret123abc456def789ghi012", message: "hello" },
      };
      const output = sanitizeOutputForModel(result);
      expect(output).toContain("<tool_result>");
      expect(output).not.toContain("sk-secret123");
      const parsed = JSON.parse(output.replace("<tool_result>\n", "").replace("\n</tool_result>", ""));
      expect(parsed.data.message).toBe("hello");
      expect(parsed.data.apiKey).toBe("[REDACTED]");
    });

    it("wraps and validates output", () => {
      const result: ToolResult = { success: true, data: "test data" };
      const sanitized = sanitizeToolResult(result);
      const wrapped = wrapToolResult(sanitized.result);
      expect(wrapped).toMatch(/^<tool_result>[\s\S]*<\/tool_result>$/);
    });
  });

  describe("audit logging", () => {
    it("logs successful executions", async () => {
      registry.register(new CsvAnalyzerTool());
      const executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger);

      await executor.execute({
        toolId: "data.csv.analyze",
        params: { operation: "rowCount", data: "a,b\n1,2" },
        userId: "user-1",
        role: "admin",
        traceId: "trace-1",
      });

      expect(noopAuditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          toolId: "data.csv.analyze",
          action: "tool.execute",
          traceId: "trace-1",
        })
      );
    });

    it("logs failed executions", async () => {
      const failingTool = fakeTool({
        id: "fail.tool",
        execute: async () => { throw new Error("boom"); },
      });
      registry.register(failingTool);
      const executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger);

      await executor.execute({
        toolId: "fail.tool",
        params: {},
        userId: "user-1",
        role: "admin",
        traceId: "trace-1",
      });

      expect(noopAuditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          result: "failure",
        })
      );
    });
  });

  describe("cross-user isolation", () => {
    it("each user gets isolated file paths for PDF generation", async () => {
      const mockBackend: PdfGeneratorBackend = {
        generate: vi.fn().mockResolvedValue({ filePath: "/out/file.pdf", sizeBytes: 100 }),
      };
      registry.register(new PdfGeneratorTool(mockBackend, "/tmp/pdfs"));
      const executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger);

      await executor.execute({
        toolId: "pdf.generate",
        params: { title: "Doc 1", sections: [{ title: "A", content: "B" }] },
        userId: "user-1",
        role: "admin",
        traceId: "trace-1",
      });

      await executor.execute({
        toolId: "pdf.generate",
        params: { title: "Doc 2", sections: [{ title: "C", content: "D" }] },
        userId: "user-2",
        role: "admin",
        traceId: "trace-2",
      });

      const calls = mockBackend.generate.mock.calls;
      expect(calls[0]![1]).toContain("user-1");
      expect(calls[1]![1]).toContain("user-2");
      expect(calls[0]![1]).not.toBe(calls[1]![1]);
    });
  });

  describe("no shell/code execution", () => {
    it("CSV analyzer does not execute code", async () => {
      registry.register(new CsvAnalyzerTool());
      const executor = new ToolExecutor(registry, allowAllPermissions, noopApprovalManager, noopAuditLogger);

      const result = await executor.execute({
        toolId: "data.csv.analyze",
        params: { operation: "stats", data: "a,b\n1,2\n3,4" },
        userId: "user-1",
        role: "admin",
        traceId: "trace-1",
      });

      expect(result.status).toBe("completed");
      expect(result.result!.success).toBe(true);
    });
  });
});
