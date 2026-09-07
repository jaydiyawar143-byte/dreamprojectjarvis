// ---------------------------------------------------------------------------
// Sprint 7.7 / 7.8 — Download and upload containment.
//
// Two properties, both structural rather than checked-at-the-edges:
//
//   1. The model never learns a filesystem path. Stored files are addressed by
//      an opaque `downloadId`; `pathFor` is private to this module and the id
//      is a UUID, so there is no string a caller can craft into a path.
//
//   2. Uploads can only send back something this store already holds. The
//      upload tool takes a `downloadId`, never a path, so "upload
//      /etc/shadow" has no expressible form.
//
// Filenames are GENERATED, never taken from the server that served the file.
// A Content-Disposition header is attacker-controlled input, and the repo's
// own document validator already refuses separators and traversal for exactly
// this reason (packages/memory/src/extraction/document-validator.ts). Here we
// go further and do not use the remote name at all: the extension is derived
// from the sniffed format, and the stem is a UUID.
//
// Nothing written here is ever executed. There is no code path that spawns a
// process, and the extension allowlist has no executable formats in it.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { JarvisError } from "@jarvis/core";

/** Formats a browser session may keep, with the bytes that prove the claim. */
interface StorableFormat {
  extension: string;
  mimeType: string;
  /** Leading bytes every file of this format starts with. Empty means text. */
  magic: readonly number[];
}

const STORABLE_FORMATS: readonly StorableFormat[] = Object.freeze([
  { extension: ".pdf", mimeType: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { extension: ".png", mimeType: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { extension: ".jpg", mimeType: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { extension: ".gif", mimeType: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { extension: ".webp", mimeType: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] },
  {
    extension: ".docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    magic: [0x50, 0x4b, 0x03, 0x04],
  },
  { extension: ".txt", mimeType: "text/plain", magic: [] },
  { extension: ".csv", mimeType: "text/csv", magic: [] },
  { extension: ".md", mimeType: "text/markdown", magic: [] },
  { extension: ".json", mimeType: "application/json", magic: [] },
]);

/**
 * Extensions refused outright, even if the bytes were to match something else.
 *
 * Belt and braces: the allowlist above already excludes every one of these, so
 * this list exists to make the intent unmissable to a future reader adding a
 * format. Nothing in this package executes a file, and nothing should start.
 */
export const EXECUTABLE_EXTENSIONS: readonly string[] = Object.freeze([
  ".exe", ".dll", ".com", ".scr", ".bat", ".cmd", ".ps1", ".msi", ".vbs",
  ".sh", ".bash", ".zsh", ".jar", ".app", ".dmg", ".deb", ".rpm", ".apk",
]);

export interface StoredFile {
  downloadId: string;
  fileName: string;
  byteSize: number;
  mimeType: string;
  sourceOrigin: string;
}

export interface StoreBytesInput {
  /** Only its extension is consulted, and only as a hint. */
  fileName: string;
  bytes: Buffer;
  mimeType?: string;
  sourceOrigin: string;
}

export interface DownloadStoreConfig {
  /** Containment root. Everything lives under `<root>/<userId>/`. */
  root: string;
  maxBytes: number;
}

function storeError(code: "DOCUMENT_TOO_LARGE" | "DOCUMENT_UNSUPPORTED_FORMAT" | "DOCUMENT_INVALID" | "DOCUMENT_EMPTY", message: string, details?: Record<string, unknown>) {
  return new JarvisError(code, message, details);
}

function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot).toLowerCase();
}

function startsWithMagic(bytes: Buffer, magic: readonly number[]): boolean {
  if (magic.length === 0) return false;
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/** True when the buffer looks like UTF-8 text rather than something binary. */
function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 4096);
  for (const byte of sample) {
    // NUL and most C0 controls never appear in the text formats we accept.
    if (byte === 0) return false;
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
  }
  return true;
}

/**
 * Decides what a downloaded buffer actually is.
 *
 * The sniffed bytes win over both the declared MIME type and the filename,
 * because both of those come from the remote server. A `.txt` that starts with
 * `%PDF-` is a PDF; a `.pdf` full of plain text is text.
 */
export function detectStorableFormat(
  bytes: Buffer,
  hintedFileName?: string
): StorableFormat | null {
  for (const format of STORABLE_FORMATS) {
    if (startsWithMagic(bytes, format.magic)) return format;
  }

  if (!looksLikeText(bytes)) return null;

  // Text of some kind. Use the hinted extension only to pick between the text
  // formats, and fall back to plain text when it says nothing useful.
  const hinted = hintedFileName ? extensionOf(hintedFileName) : null;
  const textFormat = STORABLE_FORMATS.find(
    (format) => format.magic.length === 0 && format.extension === hinted
  );
  return textFormat ?? STORABLE_FORMATS.find((f) => f.extension === ".txt")!;
}

/**
 * Files a browser session downloaded, addressed by opaque id.
 *
 * One store serves every user; isolation is by `userId` on every call, the
 * same way every repository in this repo scopes its queries. A caller that
 * passes a different user's id gets nothing, because the path it would have to
 * name is derived from the id it supplied.
 */
export class DownloadStore {
  private readonly root: string;
  private readonly maxBytes: number;
  /** downloadId -> the record. Paths never leave this class. */
  private readonly index = new Map<string, StoredFile & { userId: string; path: string }>();

  constructor(config: DownloadStoreConfig) {
    this.root = resolve(config.root);
    this.maxBytes = config.maxBytes;
  }

  /**
   * Builds the on-disk path and proves it stayed inside the root.
   *
   * `userId` is the only caller-influenced component, and it is checked for
   * separators and traversal before it is joined. The `resolve` +
   * `startsWith` pair is the containment the repo did not previously have
   * anywhere.
   */
  private pathFor(userId: string, storedName: string): string {
    if (userId.length === 0 || /[\\/]/.test(userId) || userId.includes("..")) {
      throw storeError("DOCUMENT_INVALID", "Invalid user id for download storage");
    }
    if (/[\\/]/.test(storedName) || storedName.includes("..")) {
      throw storeError("DOCUMENT_INVALID", "Invalid stored file name");
    }

    const candidate = resolve(this.root, userId, storedName);
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (!candidate.startsWith(prefix)) {
      throw storeError("DOCUMENT_INVALID", "Resolved download path escaped the store root");
    }
    return candidate;
  }

  async storeBytes(userId: string, input: StoreBytesInput): Promise<StoredFile> {
    const { bytes } = input;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw storeError("DOCUMENT_EMPTY", "Downloaded file is empty");
    }
    if (bytes.length > this.maxBytes) {
      throw storeError("DOCUMENT_TOO_LARGE", "Downloaded file exceeds the size limit", {
        byteSize: bytes.length,
        maxBytes: this.maxBytes,
      });
    }

    const hintedExtension = extensionOf(input.fileName);
    if (hintedExtension && EXECUTABLE_EXTENSIONS.includes(hintedExtension)) {
      throw storeError(
        "DOCUMENT_UNSUPPORTED_FORMAT",
        "Executable downloads are refused",
        { extension: hintedExtension }
      );
    }

    const format = detectStorableFormat(bytes, input.fileName);
    if (!format) {
      throw storeError(
        "DOCUMENT_UNSUPPORTED_FORMAT",
        "Downloaded file is not an accepted format",
        { accepted: STORABLE_FORMATS.map((f) => f.extension) }
      );
    }

    const downloadId = randomUUID();
    const storedName = `${downloadId}${format.extension}`;
    const path = this.pathFor(userId, storedName);

    await mkdir(resolve(this.root, userId), { recursive: true });
    await writeFile(path, bytes);

    const record: StoredFile = {
      downloadId,
      fileName: storedName,
      byteSize: bytes.length,
      mimeType: format.mimeType,
      sourceOrigin: input.sourceOrigin,
    };
    this.index.set(downloadId, { ...record, userId, path });
    return record;
  }

  /** Metadata only — never the path. */
  get(userId: string, downloadId: string): StoredFile | null {
    const record = this.index.get(downloadId);
    if (!record || record.userId !== userId) return null;
    const { userId: _userId, path: _path, ...safe } = record;
    return safe;
  }

  async readBytes(userId: string, downloadId: string): Promise<Buffer | null> {
    const record = this.index.get(downloadId);
    if (!record || record.userId !== userId) return null;
    return readFile(record.path);
  }

  /**
   * Internal-only path lookup, for the one caller that genuinely needs a path:
   * handing a file to Playwright's `setInputFiles`. Scoped by user, and it
   * still never returns to the tool layer.
   */
  async resolveForUpload(userId: string, downloadId: string): Promise<string | null> {
    const record = this.index.get(downloadId);
    if (!record || record.userId !== userId) return null;
    try {
      const info = await stat(record.path);
      if (!info.isFile()) return null;
    } catch {
      return null;
    }
    if (!isAbsolute(record.path)) return null;
    return record.path;
  }
}
