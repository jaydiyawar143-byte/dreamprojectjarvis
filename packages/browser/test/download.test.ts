// ---------------------------------------------------------------------------
// Sprint 7.7 / 7.8 — Download store tests.
//
// Real files, in a real temporary directory, because the properties under test
// are about the filesystem: containment, generated names, and the fact that a
// path never escapes the store.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { JarvisError } from "@jarvis/core";

import {
  DownloadStore,
  detectStorableFormat,
  EXECUTABLE_EXTENSIONS,
} from "../src/download.js";

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const TEXT = Buffer.from("hello, this is plain text\n", "utf8");
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

let root: string;
let store: DownloadStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jarvis-browser-"));
  store = new DownloadStore({ root, maxBytes: 1024 * 1024 });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function expectJarvisError(fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(JarvisError);
    expect((error as JarvisError).code).toBe(code);
    return error as JarvisError;
  }
  throw new Error(`expected a JarvisError with code ${code}, but nothing was thrown`);
}

describe("Sprint 7.7 — format detection trusts bytes, not claims", () => {
  it("identifies formats by magic bytes", () => {
    expect(detectStorableFormat(PDF)?.extension).toBe(".pdf");
    expect(detectStorableFormat(PNG)?.extension).toBe(".png");
    expect(detectStorableFormat(DOCX)?.extension).toBe(".docx");
  });

  it("believes the bytes over a lying filename", () => {
    // A server that serves a PDF as "invoice.txt" gets a PDF.
    expect(detectStorableFormat(PDF, "invoice.txt")?.extension).toBe(".pdf");
    // And "report.pdf" full of plain text is text.
    expect(detectStorableFormat(TEXT, "report.pdf")?.extension).toBe(".txt");
  });

  it("uses the hinted extension only to pick between text formats", () => {
    expect(detectStorableFormat(TEXT, "data.csv")?.extension).toBe(".csv");
    expect(detectStorableFormat(TEXT, "notes.md")?.extension).toBe(".md");
    expect(detectStorableFormat(TEXT, "anything.unknown")?.extension).toBe(".txt");
  });

  it("REFUSES a binary it does not recognise", () => {
    expect(detectStorableFormat(ELF, "tool.bin")).toBeNull();
  });
});

describe("Sprint 7.7 — storing", () => {
  it("stores a file and returns an opaque id, never a path", async () => {
    const stored = await store.storeBytes("user-1", {
      fileName: "report.pdf",
      bytes: PDF,
      sourceOrigin: "https://example.com",
    });

    expect(stored.downloadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.byteSize).toBe(PDF.length);
    expect(stored.mimeType).toBe("application/pdf");

    // Nothing in the returned record is a filesystem path.
    for (const value of Object.values(stored)) {
      expect(String(value)).not.toContain(root);
      expect(String(value)).not.toContain("/tmp");
    }
  });

  it("GENERATES the stored filename from the id, ignoring the remote one", async () => {
    const stored = await store.storeBytes("user-1", {
      fileName: "../../../etc/passwd",
      bytes: PDF,
      sourceOrigin: "https://evil.test",
    });

    expect(stored.fileName).toBe(`${stored.downloadId}.pdf`);
    expect(stored.fileName).not.toContain("..");
    expect(stored.fileName).not.toContain("passwd");

    const files = await readdir(resolve(root, "user-1"));
    expect(files).toEqual([`${stored.downloadId}.pdf`]);
  });

  it("keeps each user in their own directory", async () => {
    await store.storeBytes("user-1", {
      fileName: "a.pdf",
      bytes: PDF,
      sourceOrigin: "https://example.com",
    });
    await store.storeBytes("user-2", {
      fileName: "b.png",
      bytes: PNG,
      sourceOrigin: "https://example.com",
    });

    expect((await readdir(resolve(root, "user-1"))).length).toBe(1);
    expect((await readdir(resolve(root, "user-2"))).length).toBe(1);
  });

  it("REFUSES an empty file", async () => {
    await expectJarvisError(
      () =>
        store.storeBytes("user-1", {
          fileName: "empty.txt",
          bytes: Buffer.alloc(0),
          sourceOrigin: "https://example.com",
        }),
      "DOCUMENT_EMPTY"
    );
  });

  it("REFUSES a file over the size cap", async () => {
    const small = new DownloadStore({ root, maxBytes: 8 });
    await expectJarvisError(
      () =>
        small.storeBytes("user-1", {
          fileName: "big.pdf",
          bytes: PDF,
          sourceOrigin: "https://example.com",
        }),
      "DOCUMENT_TOO_LARGE"
    );
  });

  it("REFUSES an unrecognised binary", async () => {
    await expectJarvisError(
      () =>
        store.storeBytes("user-1", {
          fileName: "payload.bin",
          bytes: ELF,
          sourceOrigin: "https://evil.test",
        }),
      "DOCUMENT_UNSUPPORTED_FORMAT"
    );
  });

  it.each(EXECUTABLE_EXTENSIONS.map((extension) => [extension]))(
    "REFUSES a %s download outright",
    async (extension) => {
      await expectJarvisError(
        () =>
          store.storeBytes("user-1", {
            fileName: `payload${extension}`,
            bytes: TEXT,
            sourceOrigin: "https://evil.test",
          }),
        "DOCUMENT_UNSUPPORTED_FORMAT"
      );
    }
  );

  it.each([
    ["a separator", "user/../../root"],
    ["a backslash", "user\\..\\root"],
    ["traversal", "..", ],
    ["empty", ""],
  ])("REFUSES %s as a user id", async (_label, userId) => {
    await expectJarvisError(
      () =>
        store.storeBytes(userId, {
          fileName: "a.pdf",
          bytes: PDF,
          sourceOrigin: "https://example.com",
        }),
      "DOCUMENT_INVALID"
    );
  });
});

describe("Sprint 7.8 — retrieval is scoped to the owner", () => {
  it("returns metadata to the owner", async () => {
    const stored = await store.storeBytes("user-1", {
      fileName: "a.pdf",
      bytes: PDF,
      sourceOrigin: "https://example.com",
    });
    expect(store.get("user-1", stored.downloadId)?.fileName).toBe(stored.fileName);
  });

  it("returns NOTHING to another user", async () => {
    const stored = await store.storeBytes("user-1", {
      fileName: "a.pdf",
      bytes: PDF,
      sourceOrigin: "https://example.com",
    });

    expect(store.get("user-2", stored.downloadId)).toBeNull();
    expect(await store.readBytes("user-2", stored.downloadId)).toBeNull();
    expect(await store.resolveForUpload("user-2", stored.downloadId)).toBeNull();
  });

  it("returns nothing for an unknown id", async () => {
    expect(store.get("user-1", "not-a-real-id")).toBeNull();
    expect(await store.resolveForUpload("user-1", "not-a-real-id")).toBeNull();
  });

  it("never leaks a path through the metadata accessor", async () => {
    const stored = await store.storeBytes("user-1", {
      fileName: "a.pdf",
      bytes: PDF,
      sourceOrigin: "https://example.com",
    });
    const record = store.get("user-1", stored.downloadId)!;
    expect(Object.keys(record)).toEqual([
      "downloadId",
      "fileName",
      "byteSize",
      "mimeType",
      "sourceOrigin",
    ]);
    expect(JSON.stringify(record)).not.toContain(root);
  });

  it("resolves an upload path only for the owner, and only inside the root", async () => {
    const stored = await store.storeBytes("user-1", {
      fileName: "a.pdf",
      bytes: PDF,
      sourceOrigin: "https://example.com",
    });
    const path = await store.resolveForUpload("user-1", stored.downloadId);
    expect(path).toBeTruthy();
    expect(resolve(path!).startsWith(resolve(root))).toBe(true);
  });
});
