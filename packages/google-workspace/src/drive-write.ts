// ---------------------------------------------------------------------------
// Drive writes — Phase 13. Create folder, upload, move, rename.
//
// WHAT IS ABSENT IS THE DESIGN. There is no delete, no permission change and
// no content overwrite of an existing file. Those are the three Drive writes
// that destroy something, and this phase does not implement them.
//
//   createFolder  — adds. Nothing existing is touched.
//   uploadFile    — adds a NEW file. It cannot overwrite: there is no fileId
//                   parameter, so an upload can only create.
//   moveFile      — changes parents. Reversible, but it can make a file
//                   disappear from where a colleague expects it.
//   renameFile    — changes the name. Reversible, same caveat.
//
// THE `drive.file` SCOPE IS THE REAL CONSTRAINT, and it is narrower than it
// looks: it grants access only to files this application created or the user
// explicitly opened with it. So `moveFile` and `renameFile` will legitimately
// fail with a permission error on a file JARVIS did not create — which is a
// FEATURE, and the error says so rather than implying the user did something
// wrong. Requesting `drive` (full) instead would let this phase rename
// anything in the user's Drive, which is not a power this feature needs.
// ---------------------------------------------------------------------------

import { callGoogleWrite, type GoogleWriteOutcome } from "./http-write.js";
import { buildUrl } from "./http.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,createdTime,size,owners(displayName,emailAddress),webViewLink,shared,trashed,parents";

/** Upload ceiling. A multipart body is held in memory, so this is a real bound. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const MAX_NAME_CHARS = 255;

export interface DriveWriteResult {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string | null;
  parents: string[];
  modifiedAt: string | null;
}

/**
 * Validates a file or folder name.
 *
 * Path separators and control characters are rejected rather than stripped: a
 * name containing a slash is almost always a caller trying to express a path,
 * and silently flattening it would create a file with a confusing name instead
 * of telling them Drive has no paths.
 */
export function validateName(name: string): { ok: true } | { ok: false; message: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "A name is required." };
  if (trimmed.length > MAX_NAME_CHARS) {
    return { ok: false, message: `A name may be at most ${MAX_NAME_CHARS} characters.` };
  }
  if (/[/\\]/.test(trimmed)) {
    return {
      ok: false,
      message: "A name cannot contain / or \\. Drive has folders, not paths — set a parent instead.",
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return { ok: false, message: "A name cannot contain control characters." };
  }
  return { ok: true };
}

/** A Drive id, as Google issues them. Rejects anything that could be a URL. */
export function validateFileId(id: string): { ok: true } | { ok: false; message: string } {
  const trimmed = id.trim();
  if (!trimmed) return { ok: false, message: "A file id is required." };
  if (!/^[A-Za-z0-9_-]{5,200}$/.test(trimmed)) {
    // A caller passing a share URL instead of an id is the common mistake, and
    // an id that is really a URL is how a path gets injected.
    return {
      ok: false,
      message: "That is not a valid Drive file id. Use the id from a search result, not a URL.",
    };
  }
  return { ok: true };
}

function normalize(raw: Record<string, unknown>): DriveWriteResult {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    mimeType: String(raw.mimeType ?? ""),
    webViewLink: typeof raw.webViewLink === "string" ? raw.webViewLink : null,
    parents: Array.isArray(raw.parents) ? (raw.parents as string[]) : [],
    modifiedAt: typeof raw.modifiedTime === "string" ? raw.modifiedTime : null,
  };
}

// ---------------------------------------------------------------------------

export interface DriveWriteDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class DriveWriteService {
  constructor(private readonly deps: DriveWriteDeps = {}) {}

  private common() {
    return {
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}),
    };
  }

  /** Creates an empty folder. Additive: nothing existing is modified. */
  async createFolder(
    accessToken: string,
    name: string,
    parentId?: string,
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<DriveWriteResult>> {
    const valid = validateName(name);
    if (!valid.ok) return { ok: false, status: "provider_error", message: valid.message };

    if (parentId) {
      const parent = validateFileId(parentId);
      if (!parent.ok) return { ok: false, status: "provider_error", message: parent.message };
    }

    const outcome = await callGoogleWrite<Record<string, unknown>>({
      url: buildUrl(DRIVE_API, { fields: FILE_FIELDS, supportsAllDrives: "true" }),
      method: "POST",
      accessToken,
      body: {
        name: name.trim(),
        mimeType: "application/vnd.google-apps.folder",
        ...(parentId ? { parents: [parentId] } : {}),
      },
      ...this.common(),
      ...(signal ? { signal } : {}),
    });

    if (!outcome.ok) return outcome;
    return { ok: true, body: normalize(outcome.body) };
  }

  /**
   * Uploads a NEW file with text content.
   *
   * Cannot overwrite: there is no fileId parameter, so this only ever creates.
   * Binary is accepted as base64, decoded here — the caller never hands a raw
   * buffer across the process boundary.
   *
   * Multipart/related is used rather than resumable upload: the size ceiling is
   * 5 MB, which fits one request comfortably, and a resumable session would add
   * a second piece of state to reconcile after a timeout.
   */
  async uploadFile(
    accessToken: string,
    input: {
      name: string;
      mimeType: string;
      /** UTF-8 text, or base64 when `base64` is true. */
      content: string;
      base64?: boolean;
      parentId?: string;
    },
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<DriveWriteResult>> {
    const valid = validateName(input.name);
    if (!valid.ok) return { ok: false, status: "provider_error", message: valid.message };

    if (input.parentId) {
      const parent = validateFileId(input.parentId);
      if (!parent.ok) return { ok: false, status: "provider_error", message: parent.message };
    }

    let payload: Buffer;
    try {
      payload = input.base64
        ? Buffer.from(input.content, "base64")
        : Buffer.from(input.content, "utf-8");
    } catch {
      return { ok: false, status: "provider_error", message: "The file content could not be decoded." };
    }

    if (payload.byteLength === 0) {
      return { ok: false, status: "provider_error", message: "The file has no content." };
    }
    if (payload.byteLength > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        status: "provider_error",
        message: `The file is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB upload limit.`,
      };
    }

    // A random boundary, so content that happens to contain a fixed boundary
    // string cannot terminate the part early and inject its own headers.
    const boundary = `jarvis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    const metadata = {
      name: input.name.trim(),
      mimeType: input.mimeType,
      ...(input.parentId ? { parents: [input.parentId] } : {}),
    };

    const head = Buffer.from(
      `--${boundary}\r\n` +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${input.mimeType}\r\n\r\n`,
      "utf-8"
    );
    const tail = Buffer.from(`\r\n--${boundary}--`, "utf-8");
    const body = Buffer.concat([head, payload, tail]);

    const outcome = await callGoogleWrite<Record<string, unknown>>({
      url: buildUrl(DRIVE_UPLOAD_API, {
        uploadType: "multipart",
        fields: FILE_FIELDS,
        supportsAllDrives: "true",
      }),
      method: "POST",
      accessToken,
      rawBody: {
        contentType: `multipart/related; boundary=${boundary}`,
        payload: new Uint8Array(body),
      },
      ...this.common(),
      ...(signal ? { signal } : {}),
    });

    if (!outcome.ok) return outcome;
    return { ok: true, body: normalize(outcome.body) };
  }

  /**
   * Moves a file by replacing its parents.
   *
   * `removeParents` is required by Drive, and it is supplied EXPLICITLY by the
   * caller from the file's current parents rather than guessed here — a move
   * that adds a parent without removing the old one leaves the file in two
   * places, which is not what "move" means and not what the approval showed.
   */
  async moveFile(
    accessToken: string,
    input: { fileId: string; addParentId: string; removeParentIds: string[] },
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<DriveWriteResult>> {
    for (const [label, id] of [
      ["fileId", input.fileId],
      ["addParentId", input.addParentId],
    ] as const) {
      const valid = validateFileId(id);
      if (!valid.ok) {
        return { ok: false, status: "provider_error", message: `${label}: ${valid.message}` };
      }
    }

    for (const id of input.removeParentIds) {
      const valid = validateFileId(id);
      if (!valid.ok) {
        return { ok: false, status: "provider_error", message: `removeParentIds: ${valid.message}` };
      }
    }

    const outcome = await callGoogleWrite<Record<string, unknown>>({
      url: buildUrl(`${DRIVE_API}/${encodeURIComponent(input.fileId)}`, {
        addParents: input.addParentId,
        removeParents: input.removeParentIds.join(","),
        fields: FILE_FIELDS,
        supportsAllDrives: "true",
      }),
      method: "PATCH",
      accessToken,
      // Parents move via query parameters; the body carries no field changes.
      body: {},
      ...this.common(),
      ...(signal ? { signal } : {}),
    });

    if (!outcome.ok) return outcome;
    return { ok: true, body: normalize(outcome.body) };
  }

  /** Renames a file. The only field this touches is `name`. */
  async renameFile(
    accessToken: string,
    fileId: string,
    newName: string,
    signal?: AbortSignal
  ): Promise<GoogleWriteOutcome<DriveWriteResult>> {
    const id = validateFileId(fileId);
    if (!id.ok) return { ok: false, status: "provider_error", message: id.message };

    const name = validateName(newName);
    if (!name.ok) return { ok: false, status: "provider_error", message: name.message };

    const outcome = await callGoogleWrite<Record<string, unknown>>({
      url: buildUrl(`${DRIVE_API}/${encodeURIComponent(fileId)}`, {
        fields: FILE_FIELDS,
        supportsAllDrives: "true",
      }),
      method: "PATCH",
      accessToken,
      // ONLY the name. A body carrying other fields would let a rename
      // approval change something the user never saw.
      body: { name: newName.trim() },
      ...this.common(),
      ...(signal ? { signal } : {}),
    });

    if (!outcome.ok) return outcome;
    return { ok: true, body: normalize(outcome.body) };
  }
}
