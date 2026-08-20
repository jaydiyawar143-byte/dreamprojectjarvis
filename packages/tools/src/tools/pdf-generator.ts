import { BaseTool } from "../base-tool.js";
import type { ToolResult, ToolContext } from "@jarvis/core";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const MAX_TITLE_LENGTH = 500;
const MAX_CONTENT_LENGTH = 500_000;
const MAX_SECTIONS = 100;
const MAX_SECTION_TITLE_LENGTH = 200;
const MAX_SECTION_CONTENT_LENGTH = 100_000;
const DEFAULT_OUTPUT_DIR = "storage/pdfs";

function sanitizeText(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .trim();
}

function preventPathTraversal(input: string): string {
  const normalized = path.normalize(input);
  if (normalized.includes("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid path: traversal detected");
  }
  return normalized;
}

export interface PdfSection {
  title: string;
  content: string;
}

export interface PdfContent {
  title: string;
  sections: PdfSection[];
  metadata?: Record<string, string>;
}

export interface PdfGeneratorBackend {
  generate(
    content: PdfContent,
    outputPath: string
  ): Promise<{ filePath: string; sizeBytes: number }>;
}

export class PdfGeneratorTool extends BaseTool {
  private readonly backend: PdfGeneratorBackend;
  private readonly outputDir: string;

  constructor(backend: PdfGeneratorBackend, outputDir?: string) {
    super(
      "pdf.generate",
      "PDF Generator",
      "Generate a PDF document from structured content. Produces a server-side PDF and returns a safe file reference.",
      "file",
      [
        {
          name: "title",
          type: "string",
          description: "The document title",
          required: true,
        },
        {
          name: "sections",
          type: "array",
          description:
            "Array of {title, content} sections. Max 100 sections.",
          required: true,
        },
        {
          name: "metadata",
          type: "object",
          description: "Optional metadata key-value pairs for the PDF",
          required: false,
        },
      ],
      false,
      ["read", "write"],
      "LOW_IMPACT",
      "1.0.0",
      true
    );
    this.backend = backend;
    this.outputDir = outputDir ?? DEFAULT_OUTPUT_DIR;
  }

  validate(params: Record<string, unknown>): boolean {
    if (!super.validate(params)) return false;

    if (typeof params.title !== "string") return false;
    if (params.title.trim().length === 0) return false;
    if (params.title.length > MAX_TITLE_LENGTH) return false;

    if (!Array.isArray(params.sections)) return false;
    if (params.sections.length === 0 || params.sections.length > MAX_SECTIONS) return false;

    for (const section of params.sections) {
      if (
        typeof section !== "object" ||
        section === null ||
        typeof (section as PdfSection).title !== "string" ||
        typeof (section as PdfSection).content !== "string"
      ) {
        return false;
      }
      if ((section as PdfSection).title.length > MAX_SECTION_TITLE_LENGTH) return false;
      if ((section as PdfSection).content.length > MAX_SECTION_CONTENT_LENGTH) return false;
    }

    if (params.metadata !== undefined) {
      if (typeof params.metadata !== "object" || params.metadata === null) return false;
    }

    return true;
  }

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const title = sanitizeText(params.title as string);
    const sections: PdfSection[] = (params.sections as Array<{ title: string; content: string }>).map(
      (s) => ({
        title: sanitizeText(s.title),
        content: sanitizeText(s.content),
      })
    );
    const metadata = (params.metadata as Record<string, string>) ?? {};

    const totalContentLength =
      title.length + sections.reduce((acc, s) => acc + s.title.length + s.content.length, 0);
    if (totalContentLength > MAX_CONTENT_LENGTH) {
      return this.failure("Total content exceeds maximum allowed size");
    }

    const userDir = preventPathTraversal(context.userId);
    const outputDir = path.join(this.outputDir, userDir);

    try {
      await fs.mkdir(outputDir, { recursive: true });
    } catch {
      return this.failure("Failed to create output directory");
    }

    const fileId = crypto.randomUUID();
    const filename = `${fileId}.pdf`;
    const outputPath = path.join(outputDir, preventPathTraversal(filename));

    const content: PdfContent = {
      title,
      sections,
      metadata: { ...metadata, generatedBy: context.userId },
    };

    try {
      const { sizeBytes } = await this.backend.generate(
        content,
        outputPath
      );

      const safeFileId = `${userDir}/${fileId}`;

      return this.success(
        {
          fileId: safeFileId,
          filename,
          sizeBytes,
          title,
          sectionCount: sections.length,
        },
        {
          toolId: this.id,
          risk: this.risk,
          userId: context.userId,
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "PDF generation failed";
      return this.failure(`PDF generation error: ${message}`);
    }
  }
}
