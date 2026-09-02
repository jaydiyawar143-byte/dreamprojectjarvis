export {
  DocumentExtractionService,
  DEFAULT_MAX_TEXT_LENGTH,
} from "./document-extraction-service.js";
export type { DocumentExtractionServiceConfig } from "./document-extraction-service.js";

export {
  decodeUtf8Strict,
  getExtension,
  isSupportedDocument,
  normalizeMimeType,
  resolveFormatByExtension,
  resolveValidationConfig,
  validateDocumentInput,
} from "./document-validator.js";
export type {
  DocumentValidationConfig,
  ResolvedValidationConfig,
  ValidatedDocument,
} from "./document-validator.js";

export {
  BLOCK_SEPARATOR,
  countWords,
  normalizeInlineText,
  normalizeText,
} from "./text-normalizer.js";

export {
  extractMarkdownSections,
  locateSections,
} from "./section-extractor.js";

export { toKnowledgeDocumentInput } from "./knowledge-document-mapper.js";
export type {
  KnowledgeDocumentInput,
  KnowledgeDocumentMapOptions,
} from "./knowledge-document-mapper.js";

export {
  createDefaultPdfBackend,
  parsePdf,
  parsePdfDate,
} from "./parsers/pdf-parser.js";
export type {
  PdfParseBackend,
  PdfParseOutput,
  PdfTextPage,
} from "./parsers/pdf-parser.js";

export {
  createDefaultDocxBackend,
  decodeHtmlEntities,
  extractHeadingsFromHtml,
  parseDocx,
} from "./parsers/docx-parser.js";
export type {
  DocxParseBackend,
  DocxParseOutput,
} from "./parsers/docx-parser.js";

export { parseText } from "./parsers/text-parser.js";

export type {
  ParsedBlock,
  ParsedDocument,
  ParsedHeading,
} from "./parsers/types.js";
