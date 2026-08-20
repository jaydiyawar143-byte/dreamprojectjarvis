import { describe, it, expect, beforeEach, vi } from "vitest";
import { PdfGeneratorTool, type PdfGeneratorBackend, type PdfContent } from "../src/tools/pdf-generator.js";

function createMockBackend(): PdfGeneratorBackend {
  return {
    generate: vi.fn().mockResolvedValue({ filePath: "/mock/output/test.pdf", sizeBytes: 1024 }),
  };
}

function validParams(overrides: Record<string, unknown> = {}) {
  return {
    title: "Test Document",
    sections: [
      { title: "Introduction", content: "This is the introduction." },
      { title: "Body", content: "This is the body content." },
    ],
    ...overrides,
  };
}

describe("PdfGeneratorTool", () => {
  let backend: PdfGeneratorBackend;
  let tool: PdfGeneratorTool;

  beforeEach(() => {
    backend = createMockBackend();
    tool = new PdfGeneratorTool(backend, "/tmp/test-pdfs");
  });

  describe("metadata", () => {
    it("has correct id", () => {
      expect(tool.id).toBe("pdf.generate");
    });

    it("has LOW_IMPACT risk", () => {
      expect(tool.risk).toBe("LOW_IMPACT");
    });

    it("does not require approval", () => {
      expect(tool.requiresApproval).toBe(false);
    });

    it("requires read and write permissions", () => {
      expect(tool.requiredPermissions).toContain("read");
      expect(tool.requiredPermissions).toContain("write");
    });

    it("is file category", () => {
      expect(tool.category).toBe("file");
    });
  });

  describe("validate", () => {
    it("passes with valid params", () => {
      expect(tool.validate(validParams())).toBe(true);
    });

    it("fails without title", () => {
      expect(tool.validate({ sections: [{ title: "A", content: "B" }] })).toBe(false);
    });

    it("fails with empty title", () => {
      expect(tool.validate(validParams({ title: "  " }))).toBe(false);
    });

    it("fails with title exceeding max length", () => {
      expect(tool.validate(validParams({ title: "x".repeat(501) }))).toBe(false);
    });

    it("fails without sections", () => {
      expect(tool.validate({ title: "Test" })).toBe(false);
    });

    it("fails with empty sections array", () => {
      expect(tool.validate(validParams({ sections: [] }))).toBe(false);
    });

    it("fails with too many sections", () => {
      const sections = Array.from({ length: 101 }, (_, i) => ({
        title: `Section ${i}`,
        content: `Content ${i}`,
      }));
      expect(tool.validate(validParams({ sections }))).toBe(false);
    });

    it("fails with section missing title", () => {
      expect(tool.validate(validParams({ sections: [{ content: "No title" }] }))).toBe(false);
    });

    it("fails with section missing content", () => {
      expect(tool.validate(validParams({ sections: [{ title: "No content" }] }))).toBe(false);
    });

    it("fails with section title too long", () => {
      expect(
        tool.validate(
          validParams({
            sections: [{ title: "x".repeat(201), content: "ok" }],
          })
        )
      ).toBe(false);
    });

    it("fails with section content too long", () => {
      expect(
        tool.validate(
          validParams({
            sections: [{ title: "ok", content: "x".repeat(100_001) }],
          })
        )
      ).toBe(false);
    });

    it("passes with metadata", () => {
      expect(
        tool.validate(validParams({ metadata: { author: "test" } }))
      ).toBe(true);
    });
  });

  describe("execute", () => {
    it("generates PDF successfully", async () => {
      const result = await tool.execute(validParams(), { userId: "user-1" });
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const data = result.data as { fileId: string; filename: string; sizeBytes: number; title: string; sectionCount: number };
      expect(data.title).toBe("Test Document");
      expect(data.sectionCount).toBe(2);
      expect(data.sizeBytes).toBe(1024);
      expect(data.fileId).toContain("user-1");
      expect(backend.generate).toHaveBeenCalledOnce();
    });

    it("rejects total content exceeding max size", async () => {
      const bigSections = Array.from({ length: 10 }, (_, i) => ({
        title: `Section ${i}`,
        content: "x".repeat(60_000),
      }));
      const result = await tool.execute(validParams({ sections: bigSections }), {
        userId: "user-1",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("exceeds maximum");
    });

    it("handles backend failure gracefully", async () => {
      (backend.generate as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Backend error")
      );
      const result = await tool.execute(validParams(), { userId: "user-1" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Backend error");
    });

    it("sanitizes text content", async () => {
      const result = await tool.execute(
        validParams({
          title: "Test\x00\x01Title",
          sections: [{ title: "Sec\x02tion", content: "Con\x03tent" }],
        }),
        { userId: "user-1" }
      );
      expect(result.success).toBe(true);
      const generateCall = (backend.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as PdfContent;
      expect(generateCall.title).not.toContain("\x00");
      expect(generateCall.sections[0]!.title).not.toContain("\x02");
    });

    it("passes metadata to backend", async () => {
      await tool.execute(
        validParams({ metadata: { author: "JARVIS", version: "1.0" } }),
        { userId: "user-1" }
      );
      const generateCall = (backend.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as PdfContent;
      expect(generateCall.metadata?.author).toBe("JARVIS");
      expect(generateCall.metadata?.generatedBy).toBe("user-1");
    });
  });

  describe("path security", () => {
    it("includes userId in file path for isolation", async () => {
      await tool.execute(validParams(), { userId: "user-42" });
      const generateCall = (backend.generate as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(generateCall[1]).toContain("user-42");
    });

    it("generates unique file IDs", async () => {
      await tool.execute(validParams(), { userId: "user-1" });
      await tool.execute(validParams(), { userId: "user-1" });
      const call1 = (backend.generate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
      const call2 = (backend.generate as ReturnType<typeof vi.fn>).mock.calls[1]![1] as string;
      expect(call1).not.toBe(call2);
    });
  });
});
