import { deflateRawSync } from "node:zlib";

/**
 * Fixture builders for Sprint 3.2 extraction tests.
 *
 * Fixtures are generated rather than checked in as binaries so that every byte
 * a test depends on is visible in the source: when an assertion about page
 * boundaries or headings fails, the document that produced it can be read.
 */

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export interface PdfFixtureOptions {
  title?: string;
  author?: string;
  /** Raw PDF date strings, e.g. "D:20240115103000Z". */
  creationDate?: string;
  modificationDate?: string;
}

/**
 * Builds a minimal uncompressed PDF with one text-bearing page per entry.
 *
 * Object layout: 1 = Catalog, 2 = Pages, 3 = Font, then a Page and a Contents
 * object per page.
 */
export function buildPdf(
  pageTexts: readonly string[],
  options: PdfFixtureOptions = {}
): Uint8Array {
  const catalogNum = 1;
  const pagesNum = 2;
  const fontNum = 3;
  const body: string[] = [];
  const pageObjs: Array<{ pageNum: number; contentNum: number; text: string }> = [];

  let next = 4;
  for (const text of pageTexts) {
    pageObjs.push({ pageNum: next++, contentNum: next++, text });
  }
  const pageNums = pageObjs.map((p) => p.pageNum);

  body[catalogNum] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
  body[pagesNum] =
    `<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(" ")}] ` +
    `/Count ${pageNums.length} >>`;
  body[fontNum] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  for (const { pageNum, contentNum, text } of pageObjs) {
    body[pageNum] =
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`;
    const stream = `BT /F1 24 Tf 72 700 Td (${escapePdfString(text)}) Tj ET`;
    body[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < body.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${body[i]}\nendobj\n`;
  }

  const xrefStart = out.length;
  out += `xref\n0 ${body.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < body.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }

  const info: string[] = [];
  if (options.title !== undefined) info.push(`/Title (${escapePdfString(options.title)})`);
  if (options.author !== undefined) info.push(`/Author (${escapePdfString(options.author)})`);
  if (options.creationDate !== undefined) info.push(`/CreationDate (${options.creationDate})`);
  if (options.modificationDate !== undefined) info.push(`/ModDate (${options.modificationDate})`);

  out +=
    `trailer\n<< /Size ${body.length} /Root ${catalogNum} 0 R` +
    (info.length > 0 ? ` /Info << ${info.join(" ")} >>` : "") +
    ` >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(out, "latin1"));
}

function escapePdfString(text: string): string {
  return text.replace(/([()\\])/g, "\\$1");
}

// ---------------------------------------------------------------------------
// ZIP / DOCX
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: string | Buffer;
}

/** Builds a deflate-compressed ZIP archive with fixed timestamps. */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const compressed = deflateRawSync(content);
    const crc = crc32(content);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01, keeps fixtures byte-stable
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

export interface DocxParagraph {
  text: string;
  /** A Word heading style id such as "Heading1"; omitted for body text. */
  style?: string;
}

/** Builds a minimal but structurally valid .docx package. */
export function buildDocx(paragraphs: readonly DocxParagraph[]): Uint8Array {
  const body = paragraphs
    .map(({ text, style }) => {
      const pPr = style === undefined ? "" : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
      return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
    })
    .join("");

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

  return new Uint8Array(
    buildZip([
      { name: "[Content_Types].xml", data: CONTENT_TYPES },
      { name: "_rels/.rels", data: PACKAGE_RELS },
      { name: "word/document.xml", data: document },
    ])
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}
