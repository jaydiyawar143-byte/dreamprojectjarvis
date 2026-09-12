// ---------------------------------------------------------------------------
// GoogleDriveService — read-only.
//
// Three actions: search files, list recent files, get one file's metadata. No
// download, no upload, no rename, no delete, no permission change.
//
// METADATA ONLY, NOT CONTENT. Nothing here calls `?alt=media`, so no file
// content is ever fetched — a Drive read in this phase returns a name, a kind,
// a modified time and a link. The link opens in the user's own browser against
// their own Google session, which means access is re-checked by Google at the
// moment of opening rather than inherited from this server.
//
// TRASHED FILES ARE EXCLUDED BY DEFAULT. A search that returns deleted files
// looks like a bug and buries the results people wanted.
// ---------------------------------------------------------------------------

import type { DriveFile, DriveListResult } from "@jarvis/core";
import { buildUrl, callGoogle, type GoogleCallOutcome } from "./http.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";

const MAX_RESULTS = 25;

/**
 * The field mask.
 *
 * Explicit rather than default, for two reasons: Drive's default response omits
 * most of what a useful list shows, and an explicit mask means this service
 * fetches exactly what it normalizes — no unread field can drift into a log or
 * a cache.
 */
const FIELDS =
  "nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,size,owners(displayName,emailAddress),webViewLink,shared,trashed)";

const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,createdTime,size,owners(displayName,emailAddress),webViewLink,shared,trashed";

interface RawFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  createdTime?: string;
  size?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  webViewLink?: string;
  shared?: boolean;
  trashed?: boolean;
}

/**
 * Plain-English kind from a MIME type.
 *
 * `application/vnd.google-apps.presentation` is not something to show a person,
 * and "Presentation" is the word they used when they asked for one — which
 * matters directly for "Drive mein presentation dhoondo".
 */
const KIND_BY_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.form": "Google Form",
  "application/vnd.google-apps.drawing": "Google Drawing",
  "application/vnd.google-apps.folder": "Folder",
  "application/vnd.google-apps.script": "Apps Script",
  "application/pdf": "PDF",
  "text/plain": "Text file",
  "text/csv": "CSV",
  "application/zip": "Archive",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel spreadsheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
};

function describeKind(mimeType: string): string {
  const known = KIND_BY_MIME[mimeType];
  if (known) return known;
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType.startsWith("video/")) return "Video";
  if (mimeType.startsWith("audio/")) return "Audio";
  return "File";
}

function toFile(raw: RawFile): DriveFile {
  const mimeType = raw.mimeType ?? "application/octet-stream";
  return {
    id: raw.id ?? "",
    name: raw.name ?? "(untitled)",
    mimeType,
    kind: describeKind(mimeType),
    modifiedAt: raw.modifiedTime ?? new Date(0).toISOString(),
    createdAt: raw.createdTime ?? null,
    // Google Workspace native files report no size at all, which is different
    // from a size of zero and is reported as such.
    sizeBytes: raw.size !== undefined ? Number(raw.size) : null,
    owners: (raw.owners ?? [])
      .map((o) => o.displayName || o.emailAddress || "")
      .filter(Boolean),
    webViewLink: raw.webViewLink ?? null,
    shared: raw.shared ?? false,
    trashed: raw.trashed ?? false,
  };
}

/**
 * Escapes a value for Drive's query language.
 *
 * Drive queries are strings with quoted literals, so an unescaped apostrophe in
 * a filename ("Q3 O'Brien deck") breaks the query — and an unescaped backslash
 * or quote is how a caller would alter its structure. Escaped rather than
 * rejected, because apostrophes in filenames are perfectly ordinary.
 */
function escapeQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Turns a plain phrase into a Drive query.
 *
 * "presentation", "slides", "pdf" and friends are read as a KIND filter as well
 * as a name match, because "Drive mein presentation dhoondo" means "find my
 * presentations", not "find files with the word presentation in the title".
 */
const KIND_HINTS: Array<{ pattern: RegExp; mimeType: string }> = [
  { pattern: /\b(presentation|slides?|ppt|powerpoint)\b/i, mimeType: "application/vnd.google-apps.presentation" },
  { pattern: /\b(spreadsheets?|sheets?|excel|xls)\b/i, mimeType: "application/vnd.google-apps.spreadsheet" },
  { pattern: /\b(docs?|documents?|word)\b/i, mimeType: "application/vnd.google-apps.document" },
  { pattern: /\bpdfs?\b/i, mimeType: "application/pdf" },
  { pattern: /\bfolders?\b/i, mimeType: "application/vnd.google-apps.folder" },
];

export function buildSearchQuery(phrase: string): string {
  const trimmed = phrase.trim();
  const clauses: string[] = ["trashed = false"];

  const hint = KIND_HINTS.find((h) => h.pattern.test(trimmed));

  // Strip the kind word out of the name match: searching for the literal word
  // "presentation" inside filenames finds almost nothing, while the mimeType
  // filter finds exactly the right set.
  const nameTerm = hint ? trimmed.replace(hint.pattern, "").trim() : trimmed;

  if (hint) clauses.push(`mimeType = '${hint.mimeType}'`);
  if (nameTerm) clauses.push(`name contains '${escapeQueryLiteral(nameTerm)}'`);

  return clauses.join(" and ");
}

// ---------------------------------------------------------------------------

export interface DriveServiceDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GoogleDriveService {
  constructor(private readonly deps: DriveServiceDeps = {}) {}

  private call<T>(url: string, accessToken: string, signal?: AbortSignal) {
    return callGoogle<T>({
      url,
      accessToken,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  private async list(
    accessToken: string,
    query: string,
    orderBy: string,
    limit: number,
    pageToken?: string,
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<DriveListResult>> {
    const outcome = await this.call<{ files?: RawFile[]; nextPageToken?: string }>(
      buildUrl(DRIVE_API, {
        q: query,
        orderBy,
        pageSize: Math.min(Math.max(limit, 1), MAX_RESULTS),
        fields: FIELDS,
        pageToken,
        // Shared drives are part of "my files" for most people in an org.
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      }),
      accessToken,
      signal
    );

    if (!outcome.ok) return outcome;

    return {
      ok: true,
      body: {
        files: (outcome.body.files ?? []).map(toFile),
        nextPageToken: outcome.body.nextPageToken ?? null,
      },
    };
  }

  /** "Drive mein presentation dhoondo" */
  async searchFiles(
    accessToken: string,
    phrase: string,
    limit = 10,
    pageToken?: string,
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<DriveListResult>> {
    if (!phrase.trim()) {
      return { ok: false, status: "provider_error", message: "A search phrase is required." };
    }
    // Relevance ordering, not recency: the user asked for a specific thing.
    return this.list(accessToken, buildSearchQuery(phrase), "modifiedTime desc", limit, pageToken, signal);
  }

  /** "Drive ki recent files dikhao" */
  async listRecentFiles(
    accessToken: string,
    limit = 10,
    pageToken?: string,
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<DriveListResult>> {
    // Folders excluded: "recent files" means documents, and folders would
    // otherwise dominate the list for anyone who reorganises their Drive.
    return this.list(
      accessToken,
      "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      "modifiedTime desc",
      limit,
      pageToken,
      signal
    );
  }

  async getFileMetadata(
    accessToken: string,
    fileId: string,
    signal?: AbortSignal
  ): Promise<GoogleCallOutcome<DriveFile>> {
    const outcome = await this.call<RawFile>(
      buildUrl(`${DRIVE_API}/${encodeURIComponent(fileId)}`, {
        fields: FILE_FIELDS,
        supportsAllDrives: "true",
      }),
      accessToken,
      signal
    );
    if (!outcome.ok) return outcome;
    return { ok: true, body: toFile(outcome.body) };
  }
}
