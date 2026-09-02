import { describe, it, expect } from "vitest";
import { JarvisError } from "@jarvis/core";
import {
  decodeUtf8Strict,
  getExtension,
  isSupportedDocument,
  normalizeMimeType,
  resolveFormatByExtension,
  resolveValidationConfig,
  validateDocumentInput,
} from "../src/extraction/document-validator.js";
import { buildDocx, buildPdf, utf8 } from "./document-fixtures.js";

/** Asserts a call throws a JarvisError carrying the expected code. */
function expectError(fn: () => unknown, code: string): JarvisError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(JarvisError);
    const jarvisError = error as JarvisError;
    expect(jarvisError.code).toBe(code);
    return jarvisError;
  }
  throw new Error(`Expected a JarvisError with code ${code}, but nothing was thrown`);
}

describe("getExtension", () => {
  it("returns the lowercased extension", () => {
    expect(getExtension("Report.PDF")).toBe(".pdf");
  });

  it("returns the final extension for multi-dot names", () => {
    expect(getExtension("archive.tar.gz")).toBe(".gz");
  });

  it("returns null when there is no extension", () => {
    expect(getExtension("README")).toBeNull();
  });

  it("returns null for a trailing dot", () => {
    expect(getExtension("report.")).toBeNull();
  });

  it("returns null for a dotfile with no extension", () => {
    expect(getExtension(".gitignore")).toBeNull();
  });
});

describe("resolveFormatByExtension", () => {
  it.each([
    ["notes.pdf", "PDF"],
    ["notes.docx", "DOCX"],
    ["notes.txt", "TXT"],
    ["notes.md", "MD"],
    ["notes.markdown", "MD"],
    ["NOTES.MD", "MD"],
  ])("resolves %s to %s", (fileName, expected) => {
    expect(resolveFormatByExtension(fileName)).toBe(expected);
  });

  it.each(["notes.exe", "notes.csv", "notes.doc", "notes.pptx", "notes"])(
    "returns null for %s",
    (fileName) => {
      expect(resolveFormatByExtension(fileName)).toBeNull();
    }
  );
});

describe("normalizeMimeType", () => {
  it("strips parameters and lowercases", () => {
    expect(normalizeMimeType("Text/Plain; charset=UTF-8")).toBe("text/plain");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeMimeType("  application/pdf  ")).toBe("application/pdf");
  });
});

describe("resolveValidationConfig", () => {
  it("applies defaults when nothing is configured", () => {
    const config = resolveValidationConfig();
    expect(config.maxFileSizeBytes).toBe(20 * 1024 * 1024);
    expect(config.maxFileNameLength).toBe(255);
    expect(config.allowedFormats).toEqual(["PDF", "DOCX", "TXT", "MD"]);
  });

  it("honours a configured maximum file size", () => {
    expect(resolveValidationConfig({ maxFileSizeBytes: 1024 }).maxFileSizeBytes).toBe(
      1024
    );
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects an invalid maxFileSizeBytes of %s",
    (value) => {
      expectError(
        () => resolveValidationConfig({ maxFileSizeBytes: value }),
        "INVALID_REQUEST"
      );
    }
  );

  it("rejects an empty allowedFormats list", () => {
    expectError(() => resolveValidationConfig({ allowedFormats: [] }), "INVALID_REQUEST");
  });
});

describe("validateDocumentInput — file name safety", () => {
  const content = utf8("hello");

  it("accepts a plain file name", () => {
    const result = validateDocumentInput({ fileName: "notes.txt", content });
    expect(result.fileName).toBe("notes.txt");
    expect(result.format).toBe("TXT");
  });

  it("trims surrounding whitespace from the file name", () => {
    expect(
      validateDocumentInput({ fileName: "  notes.txt  ", content }).fileName
    ).toBe("notes.txt");
  });

  it.each([undefined, null, "", "   ", 42, {}])(
    "rejects an invalid file name (%s)",
    (fileName) => {
      expectError(
        () =>
          validateDocumentInput({
            fileName: fileName as string,
            content,
          }),
        "DOCUMENT_INVALID"
      );
    }
  );

  it.each([
    "../../etc/passwd.txt",
    "..\\..\\windows\\system32\\config.txt",
    "/etc/passwd.txt",
    "C:\\Users\\notes.txt",
    "sub/dir/notes.txt",
  ])("rejects the path %s", (fileName) => {
    expectError(() => validateDocumentInput({ fileName, content }), "DOCUMENT_INVALID");
  });

  it("rejects traversal sequences without a separator", () => {
    expectError(
      () => validateDocumentInput({ fileName: "no..tes.txt", content }),
      "DOCUMENT_INVALID"
    );
  });

  it("rejects a file name containing a NUL byte", () => {
    expectError(
      () =>
        validateDocumentInput({
          fileName: `notes${String.fromCodePoint(0)}.txt`,
          content,
        }),
      "DOCUMENT_INVALID"
    );
  });

  it("rejects a file name over the configured length", () => {
    const error = expectError(
      () =>
        validateDocumentInput(
          { fileName: `${"a".repeat(300)}.txt`, content },
          { maxFileNameLength: 32 }
        ),
      "DOCUMENT_INVALID"
    );
    expect(error.details).toMatchObject({ maxFileNameLength: 32 });
  });
});

describe("validateDocumentInput — size limits", () => {
  it("rejects an empty file", () => {
    const error = expectError(
      () => validateDocumentInput({ fileName: "notes.txt", content: new Uint8Array(0) }),
      "DOCUMENT_EMPTY"
    );
    expect(error.statusCode).toBe(422);
  });

  it("rejects a file over the configured maximum", () => {
    const error = expectError(
      () =>
        validateDocumentInput(
          { fileName: "notes.txt", content: utf8("a".repeat(2048)) },
          { maxFileSizeBytes: 1024 }
        ),
      "DOCUMENT_TOO_LARGE"
    );
    expect(error.statusCode).toBe(413);
    expect(error.details).toMatchObject({ byteSize: 2048, maxFileSizeBytes: 1024 });
  });

  it("accepts a file exactly at the maximum", () => {
    expect(
      validateDocumentInput(
        { fileName: "notes.txt", content: utf8("a".repeat(1024)) },
        { maxFileSizeBytes: 1024 }
      ).byteSize
    ).toBe(1024);
  });

  it("checks size before format, so an oversized unsupported file reports its size", () => {
    expectError(
      () =>
        validateDocumentInput(
          { fileName: "notes.exe", content: utf8("a".repeat(2048)) },
          { maxFileSizeBytes: 1024 }
        ),
      "DOCUMENT_TOO_LARGE"
    );
  });

  it("rejects content that is not a Uint8Array", () => {
    expectError(
      () =>
        validateDocumentInput({
          fileName: "notes.txt",
          content: "raw string" as unknown as Uint8Array,
        }),
      "DOCUMENT_INVALID"
    );
  });
});

describe("validateDocumentInput — format allowlist", () => {
  it.each(["notes.exe", "notes.csv", "notes.doc", "notes.pptx", "notes.html", "notes"])(
    "rejects the unsupported file %s",
    (fileName) => {
      const error = expectError(
        () => validateDocumentInput({ fileName, content: utf8("hello") }),
        "DOCUMENT_UNSUPPORTED_FORMAT"
      );
      expect(error.statusCode).toBe(415);
    }
  );

  it("rejects a supported format that is not enabled on this extractor", () => {
    expectError(
      () =>
        validateDocumentInput(
          { fileName: "notes.txt", content: utf8("hello") },
          { allowedFormats: ["PDF"] }
        ),
      "DOCUMENT_UNSUPPORTED_FORMAT"
    );
  });

  it("accepts a format that is enabled", () => {
    expect(
      validateDocumentInput(
        { fileName: "notes.md", content: utf8("# hi") },
        { allowedFormats: ["MD", "TXT"] }
      ).format
    ).toBe("MD");
  });
});

describe("validateDocumentInput — MIME validation", () => {
  it.each([
    ["notes.txt", "text/plain"],
    ["notes.md", "text/markdown"],
    ["notes.md", "text/plain"],
    ["notes.txt", "Text/Plain; charset=utf-8"],
  ])("accepts %s declared as %s", (fileName, mimeType) => {
    expect(
      validateDocumentInput({ fileName, content: utf8("hello"), mimeType }).mimeType
    ).toBeTypeOf("string");
  });

  it("accepts a matching PDF MIME type", () => {
    expect(
      validateDocumentInput({
        fileName: "notes.pdf",
        content: buildPdf(["hello"]),
        mimeType: "application/pdf",
      }).mimeType
    ).toBe("application/pdf");
  });

  it("rejects a MIME type that contradicts the extension", () => {
    const error = expectError(
      () =>
        validateDocumentInput({
          fileName: "notes.txt",
          content: utf8("hello"),
          mimeType: "application/pdf",
        }),
      "DOCUMENT_INVALID"
    );
    expect(error.details).toMatchObject({ declaredMimeType: "application/pdf" });
  });

  it("rejects an executable MIME type on a text extension", () => {
    expectError(
      () =>
        validateDocumentInput({
          fileName: "notes.txt",
          content: utf8("hello"),
          mimeType: "application/x-msdownload",
        }),
      "DOCUMENT_INVALID"
    );
  });

  it("rejects a blank MIME type", () => {
    expectError(
      () =>
        validateDocumentInput({ fileName: "notes.txt", content: utf8("hi"), mimeType: "  " }),
      "DOCUMENT_INVALID"
    );
  });

  it("normalizes the recorded MIME type to the canonical one for the format", () => {
    expect(
      validateDocumentInput({
        fileName: "notes.md",
        content: utf8("# hi"),
        mimeType: "text/plain",
      }).mimeType
    ).toBe("text/markdown");
  });

  it("does not require a MIME type", () => {
    expect(validateDocumentInput({ fileName: "notes.txt", content: utf8("hi") }).mimeType).toBe(
      "text/plain"
    );
  });
});

describe("validateDocumentInput — content signatures", () => {
  it("accepts a PDF carrying the %PDF- signature", () => {
    expect(
      validateDocumentInput({ fileName: "notes.pdf", content: buildPdf(["hi"]) }).format
    ).toBe("PDF");
  });

  it("accepts a DOCX carrying the ZIP signature", () => {
    expect(
      validateDocumentInput({
        fileName: "notes.docx",
        content: buildDocx([{ text: "hi" }]),
      }).format
    ).toBe("DOCX");
  });

  it("rejects a text file renamed to .pdf", () => {
    const error = expectError(
      () =>
        validateDocumentInput({
          fileName: "notes.pdf",
          content: utf8("This is plainly not a PDF"),
        }),
      "DOCUMENT_CORRUPTED"
    );
    expect(error.statusCode).toBe(422);
  });

  it("rejects a PDF renamed to .docx", () => {
    expectError(
      () => validateDocumentInput({ fileName: "notes.docx", content: buildPdf(["hi"]) }),
      "DOCUMENT_CORRUPTED"
    );
  });

  it("rejects a file too short to carry a signature", () => {
    expectError(
      () => validateDocumentInput({ fileName: "notes.pdf", content: utf8("%P") }),
      "DOCUMENT_CORRUPTED"
    );
  });

  it("does not require a signature for text formats", () => {
    expect(
      validateDocumentInput({ fileName: "notes.txt", content: utf8("plain") }).format
    ).toBe("TXT");
  });
});

describe("decodeUtf8Strict", () => {
  it("decodes valid UTF-8", () => {
    expect(decodeUtf8Strict(utf8("héllo — ok"), "TXT")).toBe("héllo — ok");
  });

  it("rejects invalid UTF-8 byte sequences", () => {
    expectError(
      () => decodeUtf8Strict(new Uint8Array([0xff, 0xfe, 0xfd]), "TXT"),
      "DOCUMENT_INVALID"
    );
  });

  it("rejects binary content disguised as text", () => {
    expectError(
      () => decodeUtf8Strict(new Uint8Array([0x00, 0x01, 0xc3, 0x28]), "TXT"),
      "DOCUMENT_INVALID"
    );
  });
});

describe("isSupportedDocument", () => {
  it.each(["a.pdf", "a.docx", "a.txt", "a.md", "a.markdown"])(
    "reports %s as supported",
    (fileName) => {
      expect(isSupportedDocument(fileName)).toBe(true);
    }
  );

  it.each(["a.exe", "a.csv", "a", "a.doc"])("reports %s as unsupported", (fileName) => {
    expect(isSupportedDocument(fileName)).toBe(false);
  });

  it("honours the allowed format list", () => {
    expect(isSupportedDocument("a.txt", undefined, { allowedFormats: ["PDF"] })).toBe(false);
  });

  it("rejects a mismatched MIME type", () => {
    expect(isSupportedDocument("a.txt", "application/pdf")).toBe(false);
  });

  it("accepts a matching MIME type", () => {
    expect(isSupportedDocument("a.txt", "text/plain")).toBe(true);
  });

  it("never throws on malformed input", () => {
    expect(isSupportedDocument(undefined as unknown as string)).toBe(false);
    expect(isSupportedDocument("a.txt", 5 as unknown as string)).toBe(false);
  });
});
