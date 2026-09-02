import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_FILE_NAME_LENGTH,
  DOCUMENT_FORMATS,
  JarvisError,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  SUPPORTED_DOCUMENT_FORMATS,
  type DocumentExtractionRequest,
  type DocumentFormatDescriptor,
  type SupportedDocumentFormat,
} from "@jarvis/core";

/**
 * Validation gate every document passes before any parser touches its bytes.
 *
 * Checks run in a fixed order — cheapest and most decisive first — so a caller
 * always gets the most specific reason for a rejection: an oversized file
 * reports its size rather than failing later on a signature check.
 */

export interface DocumentValidationConfig {
  /** Hard byte ceiling. Defaults to {@link DEFAULT_MAX_DOCUMENT_BYTES}. */
  maxFileSizeBytes?: number;
  /** Restricts the accepted formats. Defaults to every supported format. */
  allowedFormats?: readonly SupportedDocumentFormat[];
  /** File name ceiling. Defaults to {@link DEFAULT_MAX_FILE_NAME_LENGTH}. */
  maxFileNameLength?: number;
}

export interface ValidatedDocument {
  fileName: string;
  format: SupportedDocumentFormat;
  descriptor: DocumentFormatDescriptor;
  /** Canonical MIME type for the resolved format, not the caller's spelling. */
  mimeType: string;
  byteSize: number;
}

export interface ResolvedValidationConfig {
  maxFileSizeBytes: number;
  allowedFormats: readonly SupportedDocumentFormat[];
  maxFileNameLength: number;
}

export function resolveValidationConfig(
  config: DocumentValidationConfig = {}
): ResolvedValidationConfig {
  const maxFileSizeBytes = config.maxFileSizeBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const maxFileNameLength =
    config.maxFileNameLength ?? DEFAULT_MAX_FILE_NAME_LENGTH;

  if (!Number.isInteger(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
    throw new JarvisError(
      "INVALID_REQUEST",
      "maxFileSizeBytes must be a positive integer"
    );
  }
  if (!Number.isInteger(maxFileNameLength) || maxFileNameLength <= 0) {
    throw new JarvisError(
      "INVALID_REQUEST",
      "maxFileNameLength must be a positive integer"
    );
  }

  const allowedFormats = config.allowedFormats ?? SUPPORTED_DOCUMENT_FORMATS;
  if (allowedFormats.length === 0) {
    throw new JarvisError(
      "INVALID_REQUEST",
      "allowedFormats must list at least one format"
    );
  }

  return { maxFileSizeBytes, allowedFormats, maxFileNameLength };
}

/** Lowercased extension including the dot, or `null` when there is none. */
export function getExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot).toLowerCase();
}

export function resolveFormatByExtension(
  fileName: string
): SupportedDocumentFormat | null {
  const ext = getExtension(fileName);
  if (ext === null) return null;

  for (const format of SUPPORTED_DOCUMENT_FORMATS) {
    if (DOCUMENT_FORMATS[format].extensions.includes(ext)) return format;
  }
  return null;
}

/**
 * Strips MIME parameters and normalizes case, so `Text/Plain; charset=UTF-8`
 * and `text/plain` compare equal.
 */
export function normalizeMimeType(mimeType: string): string {
  const [essence] = mimeType.split(";");
  return (essence ?? "").trim().toLowerCase();
}

const PATH_SEPARATORS = /[/\\]/;

// eslint-disable-next-line no-control-regex
const FILE_NAME_CONTROL_CHARS = new RegExp("[\\u{0}-\\u{1F}\\u{7F}]", "u");

function assertSafeFileName(fileName: unknown, maxLength: number): string {
  if (typeof fileName !== "string" || fileName.trim().length === 0) {
    throw new JarvisError(
      "DOCUMENT_INVALID",
      "File name is required and must be a non-empty string"
    );
  }

  const name = fileName.trim();

  if (name.length > maxLength) {
    throw new JarvisError(
      "DOCUMENT_INVALID",
      `File name exceeds the maximum length of ${maxLength} characters`,
      { fileNameLength: name.length, maxFileNameLength: maxLength }
    );
  }

  // The extractor takes a name, never a path. Rejecting separators outright
  // removes traversal ("../../etc/passwd") and absolute-path handling as a
  // class, rather than trying to sanitize them after the fact.
  if (PATH_SEPARATORS.test(name)) {
    throw new JarvisError(
      "DOCUMENT_INVALID",
      "File name must not contain a path separator"
    );
  }
  if (name === "." || name === ".." || name.includes("..")) {
    throw new JarvisError(
      "DOCUMENT_INVALID",
      "File name must not contain path traversal sequences"
    );
  }
  if (FILE_NAME_CONTROL_CHARS.test(name)) {
    throw new JarvisError(
      "DOCUMENT_INVALID",
      "File name must not contain control characters"
    );
  }

  return name;
}

function assertBytes(content: unknown): Uint8Array {
  if (!(content instanceof Uint8Array)) {
    throw new JarvisError(
      "DOCUMENT_INVALID",
      "Document content must be provided as a Uint8Array"
    );
  }
  return content;
}

function assertMagicBytes(
  content: Uint8Array,
  descriptor: DocumentFormatDescriptor
): void {
  const magic = descriptor.magicBytes;
  if (magic === undefined) return;

  if (content.length < magic.length) {
    throw new JarvisError(
      "DOCUMENT_CORRUPTED",
      `File is too small to be a valid ${descriptor.format} document`,
      { format: descriptor.format, byteSize: content.length }
    );
  }

  for (let i = 0; i < magic.length; i++) {
    if (content[i] !== magic[i]) {
      throw new JarvisError(
        "DOCUMENT_CORRUPTED",
        `File content does not match the ${descriptor.format} format signature`,
        { format: descriptor.format }
      );
    }
  }
}

/**
 * Decodes a text-format document as strict UTF-8.
 *
 * Strictness is deliberate: silently substituting replacement characters would
 * make extraction non-deterministic across encodings and let arbitrary binary
 * content in under a `.txt` name.
 */
export function decodeUtf8Strict(
  content: Uint8Array,
  format: SupportedDocumentFormat
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new JarvisError(
      "DOCUMENT_INVALID",
      `File is not valid UTF-8 text and cannot be read as ${format}`,
      { format }
    );
  }
}

/**
 * Validates a request and resolves the format it will be parsed as.
 *
 * Throws a `JarvisError` carrying one of the `DOCUMENT_*` codes; never returns
 * a partially-valid result.
 */
export function validateDocumentInput(
  request: DocumentExtractionRequest,
  config: DocumentValidationConfig = {}
): ValidatedDocument {
  const resolved = resolveValidationConfig(config);

  const fileName = assertSafeFileName(request?.fileName, resolved.maxFileNameLength);
  const content = assertBytes(request?.content);

  if (content.length === 0) {
    throw new JarvisError("DOCUMENT_EMPTY", "File is empty", { fileName });
  }
  if (content.length > resolved.maxFileSizeBytes) {
    throw new JarvisError(
      "DOCUMENT_TOO_LARGE",
      `File exceeds the maximum size of ${resolved.maxFileSizeBytes} bytes`,
      { byteSize: content.length, maxFileSizeBytes: resolved.maxFileSizeBytes }
    );
  }

  const format = resolveFormatByExtension(fileName);
  if (format === null) {
    throw new JarvisError(
      "DOCUMENT_UNSUPPORTED_FORMAT",
      `Unsupported file type. Supported extensions: ${SUPPORTED_DOCUMENT_EXTENSIONS.join(", ")}`,
      { fileName, supportedExtensions: [...SUPPORTED_DOCUMENT_EXTENSIONS] }
    );
  }
  if (!resolved.allowedFormats.includes(format)) {
    throw new JarvisError(
      "DOCUMENT_UNSUPPORTED_FORMAT",
      `Format ${format} is not enabled for this extractor`,
      { format, allowedFormats: [...resolved.allowedFormats] }
    );
  }

  const descriptor = DOCUMENT_FORMATS[format];

  // A declared MIME type must agree with the extension. Disagreement means the
  // caller is confused about the file or is attempting to smuggle one format
  // past a filter keyed on the other, so it is rejected rather than resolved.
  if (request.mimeType !== undefined) {
    if (typeof request.mimeType !== "string") {
      throw new JarvisError("DOCUMENT_INVALID", "mimeType must be a string");
    }
    const declared = normalizeMimeType(request.mimeType);
    if (declared.length === 0) {
      throw new JarvisError("DOCUMENT_INVALID", "mimeType must not be blank");
    }
    if (!descriptor.mimeTypes.includes(declared)) {
      throw new JarvisError(
        "DOCUMENT_INVALID",
        `Declared MIME type "${declared}" does not match the "${getExtension(fileName)}" extension`,
        {
          declaredMimeType: declared,
          expectedMimeTypes: [...descriptor.mimeTypes],
          format,
        }
      );
    }
  }

  assertMagicBytes(content, descriptor);

  return {
    fileName,
    format,
    descriptor,
    mimeType: descriptor.canonicalMimeType,
    byteSize: content.length,
  };
}

/** Non-throwing support probe backing `IDocumentExtractor.supports`. */
export function isSupportedDocument(
  fileName: string,
  mimeType?: string,
  config: DocumentValidationConfig = {}
): boolean {
  let resolved: ResolvedValidationConfig;
  try {
    resolved = resolveValidationConfig(config);
  } catch {
    return false;
  }

  if (typeof fileName !== "string") return false;

  const format = resolveFormatByExtension(fileName.trim());
  if (format === null) return false;
  if (!resolved.allowedFormats.includes(format)) return false;

  if (mimeType !== undefined) {
    if (typeof mimeType !== "string") return false;
    const declared = normalizeMimeType(mimeType);
    if (!DOCUMENT_FORMATS[format].mimeTypes.includes(declared)) return false;
  }

  return true;
}
