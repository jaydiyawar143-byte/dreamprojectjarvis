// ---------------------------------------------------------------------------
// Sprint 3.6 — Knowledge Base API
//
//   POST   /api/v1/knowledge/documents             ingest a document
//   GET    /api/v1/knowledge/documents             list own documents
//   GET    /api/v1/knowledge/documents/:id         get one document
//   GET    /api/v1/knowledge/documents/:id/chunks  list a document's chunks
//   DELETE /api/v1/knowledge/documents/:id         delete a document
//   POST   /api/v1/knowledge/search                vector similarity search
//
// Security:
//  - Every route requires a bearer token and is scoped to req.auth.userId.
//    Documents are owner-scoped in the repository, so a valid id belonging to
//    another user reads as "not found" rather than "forbidden" — IDOR-safe and
//    it does not confirm the id exists.
//  - Responses carry curated fields only. Provider names, model ids, vector
//    dimensions, cosine distances, content hashes and pipeline version strings
//    stay server-side; a JarvisError's `details` (which can carry provider ids
//    and driver messages) is never serialised.
//
// Uploads arrive as base64 inside a JSON body rather than multipart, which
// needs no new dependency and works with the app-wide express.json parser.
// That parser is capped at 10mb, and base64 inflates by about a third, so the
// decoded-byte ceiling below is set to stay comfortably underneath it.
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Response } from "express";
import { createAuthMiddleware, type AuthenticatedRequest } from "../middleware/auth.js";
import type { Container } from "../services/container.js";
import {
  KnowledgeIngestionService,
  type DocumentChunkerLike,
  type DocumentEmbedderLike,
} from "../services/knowledge-ingestion.js";
import {
  DocumentChunkingService,
  DocumentEmbeddingService,
  DocumentExtractionService,
  KnowledgeRetrievalService,
} from "@jarvis/memory";
import { PrismaKnowledgeRepository, prisma } from "@jarvis/db";
import {
  JarvisError,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  type IDocumentExtractor,
  type IKnowledgeRepository,
  type KnowledgeChunkData,
  type KnowledgeDocumentData,
  type KnowledgeRetrievalOptions,
  type RetrievedChunk,
} from "@jarvis/core";

/**
 * Largest decoded upload accepted, in bytes.
 *
 * Lower than the extractor's own 20 MiB default on purpose: the transport is
 * base64 inside a JSON body, and 6 MiB of file becomes roughly 8 MB of JSON,
 * which still fits under the app-wide 10mb express.json cap. Without this
 * check a larger upload would be rejected by the body parser with a generic
 * error instead of a documented 413.
 */
export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;

const now = () => new Date().toISOString();

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    success: false,
    error: { code, message },
    timestamp: now(),
  });
}

/**
 * Maps a thrown error onto the response.
 *
 * A `JarvisError` already carries the right status for its code, so extraction
 * and retrieval failures surface as 415, 413, 422, 429 and so on without this
 * layer re-deriving them. Its `details` are dropped: they exist for logs and
 * can name the embedding provider, the batch index, or a driver message.
 * Anything else becomes a flat 500 — an unexpected error's message is not
 * something to hand to a client.
 */
function failFromError(res: Response, error: unknown, fallbackMessage: string): void {
  if (error instanceof JarvisError) {
    fail(res, error.statusCode, error.code, error.message);
    return;
  }
  fail(res, 500, "INTERNAL_ERROR", fallbackMessage);
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** Base64 with optional padding, after whitespace is stripped. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

interface DecodedUpload {
  bytes: Uint8Array;
}

type ValidationFailure = { code: string; status: number; message: string };

function isFailure(value: unknown): value is ValidationFailure {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

/**
 * Decodes the base64 payload.
 *
 * `Buffer.from(s, "base64")` silently ignores characters it cannot read, so a
 * corrupt payload would otherwise decode to plausible-looking bytes and fail
 * much later as a confusing parse error. The shape is checked first instead.
 */
function decodeBase64Content(raw: unknown): DecodedUpload | ValidationFailure {
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: "content is required and must be a base64-encoded string",
    };
  }

  const compact = raw.replace(/\s/g, "");
  if (compact.length === 0) {
    return { status: 400, code: "DOCUMENT_EMPTY", message: "content is empty" };
  }
  if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: "content is not valid base64",
    };
  }

  const buffer = Buffer.from(compact, "base64");
  if (buffer.length === 0) {
    return { status: 400, code: "DOCUMENT_EMPTY", message: "content is empty" };
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return {
      status: 413,
      code: "DOCUMENT_TOO_LARGE",
      message: `File exceeds the maximum upload size of ${MAX_UPLOAD_BYTES} bytes`,
    };
  }

  return { bytes: new Uint8Array(buffer) };
}

/** Optional string field: absent is fine, present-but-wrong is not. */
function optionalString(
  value: unknown,
  field: string,
  maxLength = 1024
): string | undefined | ValidationFailure {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    return { status: 400, code: "INVALID_REQUEST", message: `${field} must be a string` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: `${field} must not be blank when provided`,
    };
  }
  if (trimmed.length > maxLength) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: `${field} must not exceed ${maxLength} characters`,
    };
  }
  return trimmed;
}

/** Optional array-of-strings filter. */
function optionalStringArray(
  value: unknown,
  field: string
): string[] | undefined | ValidationFailure {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: `${field} must be an array of strings`,
    };
  }
  if (value.some((entry) => typeof entry !== "string")) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: `${field} must contain only strings`,
    };
  }
  if (value.length > 100) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: `${field} must not contain more than 100 entries`,
    };
  }
  return value as string[];
}

/** Document and chunk ids are cuids; anything else cannot be a real row. */
function isValidId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNumber(source: Record<string, unknown> | null, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(source: Record<string, unknown> | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Public view of a document.
 *
 * The stored metadata blob also holds `contentHash`, `extractionVersion` and
 * raw page/section offset tables. Those describe how the pipeline works, not
 * what the document is, so only the counts a client can act on are lifted out.
 */
function toPublicDocument(
  document: KnowledgeDocumentData,
  options: { includeContent?: boolean } = {}
): Record<string, unknown> {
  const metadata = asRecord(document.metadata);

  const view: Record<string, unknown> = {
    id: document.id,
    title: document.title,
    documentType: document.documentType,
    mimeType: document.mimeType,
    source: document.source,
    status: document.status,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };

  const fileName = readString(metadata, "fileName");
  if (fileName) view.fileName = fileName;

  const charCount = readNumber(metadata, "charCount");
  if (charCount !== undefined) view.charCount = charCount;

  const wordCount = readNumber(metadata, "wordCount");
  if (wordCount !== undefined) view.wordCount = wordCount;

  const byteSize = readNumber(metadata, "byteSize");
  if (byteSize !== undefined) view.byteSize = byteSize;

  const pageCount = readNumber(metadata, "pageCount");
  if (pageCount !== undefined) view.pageCount = pageCount;

  if (options.includeContent) view.content = document.content;

  return view;
}

function readPageNumbers(metadata: Record<string, unknown> | null): number[] {
  const raw = metadata?.["pageNumbers"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
}

function readSections(metadata: Record<string, unknown> | null): unknown[] {
  const raw = metadata?.["sections"];
  return Array.isArray(raw) ? raw : [];
}

function toPublicChunk(chunk: KnowledgeChunkData): Record<string, unknown> {
  const metadata = asRecord(chunk.metadata);

  const view: Record<string, unknown> = {
    id: chunk.id,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    pageNumbers: readPageNumbers(metadata),
    sections: readSections(metadata),
  };

  const charCount = readNumber(metadata, "charCount");
  if (charCount !== undefined) view.charCount = charCount;

  const wordCount = readNumber(metadata, "wordCount");
  if (wordCount !== undefined) view.wordCount = wordCount;

  const primarySection = asRecord(metadata?.["primarySection"]);
  if (primarySection) view.primarySection = primarySection;

  return view;
}

/**
 * Public view of a search hit.
 *
 * `score` is kept because it is the ranking a client may want to threshold on.
 * `distance` is dropped as the raw pgvector figure behind it, and the metadata
 * blob is dropped in favour of the citation fields lifted from it.
 */
function toPublicSearchResult(chunk: RetrievedChunk): Record<string, unknown> {
  const view: Record<string, unknown> = {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    documentType: chunk.documentType,
    source: chunk.source,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    score: chunk.score,
    pageNumbers: chunk.pageNumbers,
    sections: chunk.sections,
  };

  if (chunk.primarySection) view.primarySection = chunk.primarySection;
  if (chunk.startOffset !== undefined) view.startOffset = chunk.startOffset;
  if (chunk.endOffset !== undefined) view.endOffset = chunk.endOffset;

  return view;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface KnowledgeRouterOverrides {
  repository?: IKnowledgeRepository;
  extractor?: IDocumentExtractor;
  chunker?: DocumentChunkerLike;
  embedder?: DocumentEmbedderLike | null;
  retriever?: Pick<KnowledgeRetrievalService, "retrieve"> | null;
}

export function createKnowledgeRouter(
  container: Container,
  overrides: KnowledgeRouterOverrides = {}
): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(container.tokenService);

  const repository =
    overrides.repository ?? container.knowledgeRepo ?? new PrismaKnowledgeRepository(prisma);

  const extractor = overrides.extractor ?? new DocumentExtractionService();
  const chunker = overrides.chunker ?? new DocumentChunkingService();

  // The embedding stack is optional for the same reason the memory stack is:
  // without OPENAI_API_KEY the container leaves `embeddingProvider` null and
  // the app still starts. Ingestion degrades to storing text and chunks;
  // search, which cannot work without a query vector, reports 503.
  const provider = container.embeddingProvider;
  const embedder: DocumentEmbedderLike | null =
    overrides.embedder !== undefined
      ? overrides.embedder
      : provider
        ? new DocumentEmbeddingService({ provider })
        : null;

  const retriever =
    overrides.retriever !== undefined
      ? overrides.retriever
      : provider
        ? new KnowledgeRetrievalService({ provider, repository })
        : null;

  const ingestion = new KnowledgeIngestionService({
    repository,
    extractor,
    chunker,
    embedder,
  });

  /** Resolves the caller, or ends the response. */
  const identify = (req: AuthenticatedRequest, res: Response): string | null => {
    if (!req.auth?.userId) {
      fail(res, 401, "AUTHENTICATION_REQUIRED", "Authentication required");
      return null;
    }
    return req.auth.userId;
  };

  // -------------------------------------------------------------------------
  // POST /documents — ingest
  // -------------------------------------------------------------------------
  router.post("/documents", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = identify(req, res);
    if (!userId) return;

    const body = asRecord(req.body);
    if (!body) {
      return fail(res, 400, "INVALID_REQUEST", "A JSON request body is required");
    }

    const fileName = body.fileName;
    if (typeof fileName !== "string" || fileName.trim().length === 0) {
      return fail(res, 400, "INVALID_REQUEST", "fileName is required");
    }

    // Checked before decoding so an unsupported upload is rejected without
    // spending time on a payload that can never be processed.
    if (!extractor.supports(fileName, typeof body.mimeType === "string" ? body.mimeType : undefined)) {
      return fail(
        res,
        415,
        "DOCUMENT_UNSUPPORTED_FORMAT",
        `Unsupported file type. Supported extensions: ${SUPPORTED_DOCUMENT_EXTENSIONS.join(", ")}`
      );
    }

    const decoded = decodeBase64Content(body.content);
    if (isFailure(decoded)) {
      return fail(res, decoded.status, decoded.code, decoded.message);
    }

    const mimeType = optionalString(body.mimeType, "mimeType", 255);
    if (isFailure(mimeType)) return fail(res, mimeType.status, mimeType.code, mimeType.message);

    const source = optionalString(body.source, "source", 512);
    if (isFailure(source)) return fail(res, source.status, source.code, source.message);

    const title = optionalString(body.title, "title", 512);
    if (isFailure(title)) return fail(res, title.status, title.code, title.message);

    try {
      const result = await ingestion.ingest(userId, {
        fileName: fileName.trim(),
        content: decoded.bytes,
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(title !== undefined ? { title } : {}),
      });

      await container.auditLogger
        .log({
          userId,
          action: "knowledge.document.ingest",
          result: "success",
          metadata: {
            documentId: result.document.id,
            format: result.extraction.format,
            byteSize: result.extraction.byteSize,
            chunkCount: result.chunkCount,
            embeddedCount: result.embeddedCount,
            status: result.status,
          },
        })
        .catch(() => undefined);

      res.status(201).json({
        success: true,
        data: {
          document: toPublicDocument(result.document),
          chunkCount: result.chunkCount,
          embeddedCount: result.embeddedCount,
          skippedCount: result.skippedCount,
          embedded: result.embedded,
          searchable: result.embedded && result.embeddedCount > 0,
        },
        timestamp: now(),
      });
    } catch (error) {
      await container.auditLogger
        .log({
          userId,
          action: "knowledge.document.ingest",
          result: "failure",
          metadata: {
            code: error instanceof JarvisError ? error.code : "INTERNAL_ERROR",
          },
        })
        .catch(() => undefined);

      failFromError(res, error, "Failed to ingest document");
    }
  });

  // -------------------------------------------------------------------------
  // GET /documents — list
  // -------------------------------------------------------------------------
  router.get("/documents", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = identify(req, res);
    if (!userId) return;

    try {
      const documents = await repository.listDocuments(userId);
      res.status(200).json({
        success: true,
        data: {
          documents: documents.map((doc) => toPublicDocument(doc)),
          total: documents.length,
        },
        timestamp: now(),
      });
    } catch (error) {
      failFromError(res, error, "Failed to list documents");
    }
  });

  // -------------------------------------------------------------------------
  // GET /documents/:id — read one
  // -------------------------------------------------------------------------
  router.get("/documents/:id", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = identify(req, res);
    if (!userId) return;

    if (!isValidId(req.params.id)) {
      return fail(res, 400, "INVALID_REQUEST", "Invalid document id");
    }

    try {
      const document = await repository.getDocumentById(req.params.id, userId);
      if (!document) {
        return fail(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      }

      res.status(200).json({
        success: true,
        data: { document: toPublicDocument(document, { includeContent: true }) },
        timestamp: now(),
      });
    } catch (error) {
      failFromError(res, error, "Failed to fetch document");
    }
  });

  // -------------------------------------------------------------------------
  // GET /documents/:id/chunks — read chunks
  // -------------------------------------------------------------------------
  router.get(
    "/documents/:id/chunks",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = identify(req, res);
      if (!userId) return;

      if (!isValidId(req.params.id)) {
        return fail(res, 400, "INVALID_REQUEST", "Invalid document id");
      }

      try {
        // Ownership is established here rather than by catching the
        // repository's error, so a document owned by someone else is a plain
        // 404 and never leaks that the id exists.
        const document = await repository.getDocumentById(req.params.id, userId);
        if (!document) {
          return fail(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
        }

        const chunks = await repository.getChunksByDocument(document.id, userId);
        res.status(200).json({
          success: true,
          data: {
            documentId: document.id,
            chunks: chunks.map(toPublicChunk),
            total: chunks.length,
          },
          timestamp: now(),
        });
      } catch (error) {
        failFromError(res, error, "Failed to fetch document chunks");
      }
    }
  );

  // -------------------------------------------------------------------------
  // DELETE /documents/:id
  // -------------------------------------------------------------------------
  router.delete(
    "/documents/:id",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = identify(req, res);
      if (!userId) return;

      if (!isValidId(req.params.id)) {
        return fail(res, 400, "INVALID_REQUEST", "Invalid document id");
      }

      try {
        const document = await repository.getDocumentById(req.params.id, userId);
        if (!document) {
          return fail(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
        }

        await repository.deleteDocument(document.id, userId);

        await container.auditLogger
          .log({
            userId,
            action: "knowledge.document.delete",
            result: "success",
            metadata: { documentId: document.id },
          })
          .catch(() => undefined);

        res.status(200).json({
          success: true,
          data: { id: document.id, deleted: true },
          timestamp: now(),
        });
      } catch (error) {
        failFromError(res, error, "Failed to delete document");
      }
    }
  );

  // -------------------------------------------------------------------------
  // POST /search — vector retrieval
  // -------------------------------------------------------------------------
  router.post("/search", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const userId = identify(req, res);
    if (!userId) return;

    const body = asRecord(req.body);
    if (!body) {
      return fail(res, 400, "INVALID_REQUEST", "A JSON request body is required");
    }

    // A missing or non-string `query` is a malformed request. An empty string
    // is a well-formed request with nothing to search, which the retrieval
    // layer answers with an empty result rather than an error.
    if (typeof body.query !== "string") {
      return fail(res, 400, "INVALID_REQUEST", "query is required and must be a string");
    }
    if (body.query.length > 4096) {
      return fail(res, 400, "INVALID_REQUEST", "query must not exceed 4096 characters");
    }

    const documentIds = optionalStringArray(body.documentIds, "documentIds");
    if (isFailure(documentIds)) {
      return fail(res, documentIds.status, documentIds.code, documentIds.message);
    }
    const documentTypes = optionalStringArray(body.documentTypes, "documentTypes");
    if (isFailure(documentTypes)) {
      return fail(res, documentTypes.status, documentTypes.code, documentTypes.message);
    }
    const sources = optionalStringArray(body.sources, "sources");
    if (isFailure(sources)) {
      return fail(res, sources.status, sources.code, sources.message);
    }
    const statuses = optionalStringArray(body.statuses, "statuses");
    if (isFailure(statuses)) {
      return fail(res, statuses.status, statuses.code, statuses.message);
    }

    if (!retriever) {
      return fail(
        res,
        503,
        "TOOL_UNAVAILABLE",
        "Knowledge search is unavailable because no embedding provider is configured"
      );
    }

    const options: KnowledgeRetrievalOptions = {};
    if (body.topK !== undefined) options.topK = body.topK as number;
    if (body.similarityThreshold !== undefined) {
      options.similarityThreshold = body.similarityThreshold as number;
    }
    if (documentIds !== undefined) options.documentIds = documentIds;
    if (documentTypes !== undefined) options.documentTypes = documentTypes;
    if (sources !== undefined) options.sources = sources;
    if (statuses !== undefined) options.statuses = statuses;

    try {
      const result = await retriever.retrieve(userId, body.query, options);

      res.status(200).json({
        success: true,
        data: {
          query: result.query,
          results: result.results.map(toPublicSearchResult),
          resultCount: result.resultCount,
          topK: result.topK,
          similarityThreshold: result.similarityThreshold,
          emptyQuery: result.emptyQuery,
        },
        timestamp: now(),
      });
    } catch (error) {
      failFromError(res, error, "Knowledge search failed");
    }
  });

  return router;
}
