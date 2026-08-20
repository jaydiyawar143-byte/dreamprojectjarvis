import { BaseTool } from "../base-tool.js";
import type { ToolResult, ToolContext } from "@jarvis/core";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const MAX_FILE_SIZE = 10_000_000;
const MAX_TEXT_LENGTH = 500_000;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".txt", ".csv", ".docx"]);

const INSTRUCTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  /you\s+are\s+now\s+/i,
  /system\s*:\s*/i,
  /act\s+as\s+if/i,
  /pretend\s+you\s+are/i,
  /disregard\s+/i,
  /override\s+(system|instructions?)/i,
  /\[INST\]/i,
  /<\|im_start\|>/i,
  /<\|system\|>/i,
];

function containsInstructionInjection(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((p) => p.test(text));
}

function sanitizeText(text: string): string {
  let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
  if (sanitized.length > MAX_TEXT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_TEXT_LENGTH) + "\n[...document truncated]";
  }
  return sanitized;
}

function preventPathTraversal(filePath: string): boolean {
  if (!path.isAbsolute(filePath)) return false;
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  return !segments.includes("..");
}

function validateExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

export interface DocumentExtractor {
  extractPdf(filePath: string): Promise<string>;
  extractDocx(filePath: string): Promise<string>;
  extractTxt(filePath: string): Promise<string>;
  extractCsv(filePath: string): Promise<string>;
}

export interface FileStatInfo {
  size: number;
  isFile: boolean;
  mtime: Date;
}

export interface FileSystemInterface {
  stat(filePath: string): Promise<FileStatInfo>;
}

const defaultFileSystem: FileSystemInterface = {
  stat: async (filePath: string) => {
    const stat = await fs.stat(filePath);
    return { size: stat.size, isFile: stat.isFile(), mtime: stat.mtime };
  },
};

export class DocumentAnalyzerTool extends BaseTool {
  private readonly extractor: DocumentExtractor;
  private readonly maxFileSize: number;
  private readonly fileSystem: FileSystemInterface;

  constructor(extractor: DocumentExtractor, maxFileSize?: number, fileSystem?: FileSystemInterface) {
    super(
      "document.analyze",
      "Document Analyzer",
      "Analyze user-provided documents (PDF, TXT, CSV, DOCX). Extract text, summarize, answer questions, or perform structured extraction. Documents are treated as untrusted data.",
      "research",
      [
        {
          name: "filePath",
          type: "string",
          description: "Absolute path to the document file",
          required: true,
        },
        {
          name: "operation",
          type: "string",
          description:
            "Operation: extractText, summarize, getMetadata, wordCount, search",
          required: true,
        },
        {
          name: "query",
          type: "string",
          description: "Search query (only for 'search' operation)",
          required: false,
        },
      ],
      false,
      ["read"],
      "READ_ONLY",
      "1.0.0",
      true
    );
    this.extractor = extractor;
    this.maxFileSize = maxFileSize ?? MAX_FILE_SIZE;
    this.fileSystem = fileSystem ?? defaultFileSystem;
  }

  validate(params: Record<string, unknown>): boolean {
    if (!super.validate(params)) return false;

    if (typeof params.filePath !== "string") return false;
    if (params.filePath.trim().length === 0) return false;

    const validOps = ["extractText", "summarize", "getMetadata", "wordCount", "search"];
    if (typeof params.operation !== "string" || !validOps.includes(params.operation)) return false;

    if (params.operation === "search" && typeof params.query !== "string") return false;

    return true;
  }

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolResult> {
    const filePath = params.filePath as string;
    const operation = params.operation as string;

    if (!preventPathTraversal(filePath)) {
      return this.failure("Invalid file path: path traversal detected");
    }

    if (!validateExtension(filePath)) {
      return this.failure(
        `Unsupported file type. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`
      );
    }

    let stat: FileStatInfo;
    try {
      stat = await this.fileSystem.stat(filePath);
    } catch {
      return this.failure("File not found or inaccessible");
    }

    if (!stat.isFile) {
      return this.failure("Path is not a file");
    }

    if (stat.size > this.maxFileSize) {
      return this.failure(
        `File too large: ${stat.size} bytes (max ${this.maxFileSize})`
      );
    }

    let text: string;
    try {
      const ext = path.extname(filePath).toLowerCase();
      switch (ext) {
        case ".pdf":
          text = await this.extractor.extractPdf(filePath);
          break;
        case ".txt":
          text = await this.extractor.extractTxt(filePath);
          break;
        case ".csv":
          text = await this.extractor.extractCsv(filePath);
          break;
        case ".docx":
          text = await this.extractor.extractDocx(filePath);
          break;
        default:
          return this.failure(`Unsupported extension: ${ext}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Extraction failed";
      return this.failure(`Document extraction error: ${message}`);
    }

    if (containsInstructionInjection(text)) {
      return this.success(
        {
          warning: "Document contains potentially malicious content. Treating as untrusted data.",
          extractedLength: text.length,
        },
        { toolId: this.id, treatedAsUntrustedData: true }
      );
    }

    const sanitized = sanitizeText(text);
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    switch (operation) {
      case "extractText":
        return this.success(
          {
            text: sanitized,
            filename,
            fileType: ext,
            charCount: sanitized.length,
            wordCount: sanitized.split(/\s+/).filter(Boolean).length,
          },
          { toolId: this.id, treatedAsUntrustedData: true }
        );

      case "summarize": {
        const sentences = sanitized
          .split(/[.!?]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 10);
        const summary = sentences.slice(0, 10).join(". ");
        return this.success(
          {
            summary: summary || "No meaningful content to summarize.",
            filename,
            fileType: ext,
            totalSentences: sentences.length,
            summarySentences: Math.min(sentences.length, 10),
          },
          { toolId: this.id, treatedAsUntrustedData: true }
        );
      }

      case "getMetadata":
        return this.success(
          {
            filename,
            fileType: ext,
            sizeBytes: stat.size,
            charCount: sanitized.length,
            wordCount: sanitized.split(/\s+/).filter(Boolean).length,
            lineCount: sanitized.split("\n").length,
            modifiedAt: stat.mtime.toISOString(),
          },
          { toolId: this.id }
        );

      case "wordCount": {
        const words = sanitized.split(/\s+/).filter(Boolean);
        const wordFreq: Record<string, number> = {};
        for (const w of words) {
          const lower = w.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (lower.length > 0) {
            wordFreq[lower] = (wordFreq[lower] ?? 0) + 1;
          }
        }
        const topWords = Object.entries(wordFreq)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([word, count]) => ({ word, count }));

        return this.success(
          {
            totalWords: words.length,
            uniqueWords: Object.keys(wordFreq).length,
            topWords,
            filename,
          },
          { toolId: this.id }
        );
      }

      case "search": {
        const query = (params.query as string).trim().toLowerCase();
        const sentences = sanitized
          .split(/[.!?\n]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 5);
        const matches = sentences.filter((s) =>
          s.toLowerCase().includes(query)
        );
        return this.success(
          {
            query,
            matchCount: matches.length,
            matches: matches.slice(0, 20),
            filename,
            totalSentences: sentences.length,
          },
          { toolId: this.id, treatedAsUntrustedData: true }
        );
      }

      default:
        return this.failure(`Unknown operation: ${operation}`);
    }
  }
}
