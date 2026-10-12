// ---------------------------------------------------------------------------
// Phase 15 — on-page SEO audit and page comparison, as pure functions.
//
// WHAT THIS IS. HTML in, facts and checks out. No network, no model, no clock:
// the same page always produces the same audit. Fetching the page is somebody
// else's job (`@jarvis/browser`), which is what keeps this testable against a
// string and keeps the SSRF question in the one package that owns it.
//
// WHAT IT DELIBERATELY IS NOT. It does not know how a page ranks, how often a
// phrase is searched, who links to the page or how fast it loads. JARVIS has
// no data source for any of those, so instead of estimating them this module
// says so, in `notMeasured`, on every audit. "Top terms" are the words that
// are ON the page, counted — a fact about the page, not a claim about demand.
//
// THE SCANNER. A small tolerant tokenizer rather than a DOM. Real pages are
// malformed, and a strict parser that throws on the second unclosed tag would
// audit nothing. This one never throws: it reads tags and text in one pass,
// treats `<script>`, `<style>` and `<title>` as raw text, and is bounded by
// the input it is given. Remote HTML is DATA here — nothing in it is executed,
// evaluated or followed.
// ---------------------------------------------------------------------------

import type {
  CompetitorAnalysis,
  PageDifference,
  PageFacts,
  SeoAudit,
  SeoCheck,
  SeoCheckSeverity,
} from "./types/marketing.js";

/** Nothing past this is read. A page this large is not being audited for its prose. */
export const SEO_MAX_HTML_CHARS = 3_000_000;

const MAX_HEADINGS_KEPT = 20;
const MAX_HEADING_CHARS = 200;
const MAX_FIELD_CHARS = 600;
const TOP_TERMS = 12;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface TagToken {
  kind: "tag";
  name: string;
  attrs: Record<string, string>;
  closing: boolean;
  /** Written as `<name ... />`: it opens nothing that a later tag must close. */
  selfClosing: boolean;
}
interface TextToken {
  kind: "text";
  text: string;
}
/** A raw-text element: its content is text, never markup. */
interface RawToken {
  kind: "raw";
  name: string;
  attrs: Record<string, string>;
  text: string;
}
type Token = TagToken | TextToken | RawToken;

const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "title", "textarea"]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
});

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isNameStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isNameChar(code: number): boolean {
  return isNameStart(code) || (code >= 48 && code <= 58) || code === 45 || code === 95;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/** One pass, no backtracking, never throws. */
function tokenize(input: string): Token[] {
  const html = input.length > SEO_MAX_HTML_CHARS ? input.slice(0, SEO_MAX_HTML_CHARS) : input;
  const length = html.length;
  const tokens: Token[] = [];
  let i = 0;

  while (i < length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      tokens.push({ kind: "text", text: html.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ kind: "text", text: html.slice(i, lt) });

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? length : end + 3;
      continue;
    }
    const next = html.charCodeAt(lt + 1);
    if (next === 33 /* ! */ || next === 63 /* ? */) {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? length : end + 1;
      continue;
    }

    let cursor = lt + 1;
    const closing = next === 47; /* / */
    if (closing) cursor += 1;
    if (cursor >= length || !isNameStart(html.charCodeAt(cursor))) {
      // A bare "<" in text.
      tokens.push({ kind: "text", text: "<" });
      i = lt + 1;
      continue;
    }

    const nameStart = cursor;
    while (cursor < length && isNameChar(html.charCodeAt(cursor))) cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase();

    // Attributes. A quoted value may contain ">", which is why this is a
    // scan and not a search for the next ">".
    const attrs: Record<string, string> = {};
    let closed = false;
    let trailingSlash = false;
    while (cursor < length) {
      while (cursor < length && isSpace(html.charCodeAt(cursor))) cursor += 1;
      if (cursor >= length) break;
      const ch = html.charCodeAt(cursor);
      if (ch === 62 /* > */) {
        cursor += 1;
        closed = true;
        break;
      }
      if (ch === 47 /* / */) {
        cursor += 1;
        trailingSlash = true;
        continue;
      }
      trailingSlash = false;
      const attrStart = cursor;
      while (cursor < length) {
        const c = html.charCodeAt(cursor);
        if (isSpace(c) || c === 61 || c === 62 || c === 47) break;
        cursor += 1;
      }
      if (cursor === attrStart) {
        // A character that fits nowhere; step over it rather than loop on it.
        cursor += 1;
        continue;
      }
      const attrName = html.slice(attrStart, cursor).toLowerCase();
      while (cursor < length && isSpace(html.charCodeAt(cursor))) cursor += 1;
      let value = "";
      if (cursor < length && html.charCodeAt(cursor) === 61 /* = */) {
        cursor += 1;
        while (cursor < length && isSpace(html.charCodeAt(cursor))) cursor += 1;
        const quote = html.charCodeAt(cursor);
        if (quote === 34 || quote === 39) {
          const end = html.indexOf(quote === 34 ? '"' : "'", cursor + 1);
          const stop = end === -1 ? length : end;
          value = html.slice(cursor + 1, stop);
          cursor = end === -1 ? length : end + 1;
        } else {
          const valueStart = cursor;
          while (cursor < length) {
            const c = html.charCodeAt(cursor);
            if (isSpace(c) || c === 62) break;
            cursor += 1;
          }
          value = html.slice(valueStart, cursor);
        }
      }
      // First occurrence wins, as it does in a browser.
      if (!(attrName in attrs)) attrs[attrName] = decodeEntities(value);
    }
    if (!closed) cursor = length;

    if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
      const closeTag = new RegExp(`</${name}\\b`, "ig");
      closeTag.lastIndex = cursor;
      const match = closeTag.exec(html);
      const contentEnd = match ? match.index : length;
      tokens.push({ kind: "raw", name, attrs, text: html.slice(cursor, contentEnd) });
      if (!match) {
        i = length;
      } else {
        const gt = html.indexOf(">", match.index);
        i = gt === -1 ? length : gt + 1;
      }
      continue;
    }

    tokens.push({ kind: "tag", name, attrs, closing, selfClosing: closed && trailingSlash });
    i = cursor;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

const HEADING_LEVELS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
type HeadingLevel = (typeof HEADING_LEVELS)[number];

/** Elements whose text a reader never sees. */
const INVISIBLE_ELEMENTS: ReadonlySet<string> = new Set(["noscript", "template", "svg", "head", "iframe", "object"]);

const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use " +
    "that with have this will your from they know want been good much some time very when come here just like long make many over such take than them well were what " +
    "about after again also back because before being between both could does each even every first into more most must only other same should since still their there " +
    "these thing those through under until where which while would yours ours them then than upon onto within without against among around during " +
    "hai hain aur nahi kya yeh woh iss uss mein par bhi tha thi the kar raha rahi rahe hoga hogi apna apni apne liye saath"
  ).split(/\s+/)
);

function wordsOf(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function resolveUrl(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function collectStructuredTypes(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 50)) collectStructuredTypes(entry, into, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (typeof type === "string") into.add(type.slice(0, 60));
  else if (Array.isArray(type)) {
    for (const entry of type) if (typeof entry === "string") into.add(entry.slice(0, 60));
  }
  if (record["@graph"] !== undefined) collectStructuredTypes(record["@graph"], into, depth + 1);
}

/**
 * Read what a page says about itself.
 *
 * `pageUrl` is the address the HTML came from, used only to resolve relative
 * links and to tell an internal link from an external one.
 */
export function extractPageFacts(html: string, pageUrl: string): PageFacts {
  const tokens = tokenize(typeof html === "string" ? html : "");
  let pageHost = "";
  try {
    pageHost = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    pageHost = "";
  }

  let title: string | null = null;
  let metaDescription: string | null = null;
  let canonical: string | null = null;
  let robotsMeta: string | null = null;
  let lang: string | null = null;
  let viewport = false;
  let charset: string | null = null;
  let twitterCard: string | null = null;
  const openGraph: Record<string, string> = {};
  const structured = new Set<string>();
  const hreflang: string[] = [];
  const headings: Record<HeadingLevel, string[]> = { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] };
  const headingCounts: Record<HeadingLevel, number> = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  let imagesTotal = 0;
  let imagesMissingAlt = 0;
  let internal = 0;
  let external = 0;
  let nofollow = 0;

  let invisibleDepth = 0;
  let openHeading: { level: HeadingLevel; text: string } | null = null;
  const visible: string[] = [];

  const closeHeading = (): void => {
    if (!openHeading) return;
    const text = collapse(decodeEntities(openHeading.text));
    headingCounts[openHeading.level] += 1;
    if (text.length > 0 && headings[openHeading.level].length < MAX_HEADINGS_KEPT) {
      headings[openHeading.level].push(clip(text, MAX_HEADING_CHARS));
    }
    openHeading = null;
  };

  for (const token of tokens) {
    if (token.kind === "text") {
      if (invisibleDepth > 0) continue;
      if (openHeading) openHeading.text += token.text;
      visible.push(token.text);
      continue;
    }

    if (token.kind === "raw") {
      if (token.name === "title" && title === null) {
        const text = collapse(decodeEntities(token.text));
        title = text.length > 0 ? clip(text, MAX_FIELD_CHARS) : null;
      } else if (token.name === "script" && (token.attrs.type ?? "").toLowerCase().includes("ld+json")) {
        try {
          collectStructuredTypes(JSON.parse(token.text), structured);
        } catch {
          // Malformed structured data is the page's problem; it is simply not counted.
        }
      }
      continue;
    }

    const { name, attrs, closing } = token;

    if (INVISIBLE_ELEMENTS.has(name)) {
      if (closing) invisibleDepth = Math.max(0, invisibleDepth - 1);
      // `<svg />` opens nothing, so there is nothing to wait for the end of.
      else if (!token.selfClosing) invisibleDepth += 1;
      continue;
    }
    // A <body> ends the head even when </head> was never written.
    if (name === "body" && !closing) invisibleDepth = 0;

    if ((HEADING_LEVELS as readonly string[]).includes(name)) {
      closeHeading();
      if (!closing && invisibleDepth === 0) openHeading = { level: name as HeadingLevel, text: "" };
      continue;
    }

    if (closing) continue;

    switch (name) {
      case "html":
        if (lang === null && attrs.lang) lang = clip(attrs.lang.trim(), 35) || null;
        break;
      case "meta": {
        const key = (attrs.name ?? attrs.property ?? "").trim().toLowerCase();
        const content = collapse(attrs.content ?? "");
        if (attrs.charset && charset === null) charset = clip(attrs.charset.trim().toLowerCase(), 40);
        if ((attrs["http-equiv"] ?? "").toLowerCase() === "content-type" && charset === null) {
          const found = /charset=([\w-]+)/i.exec(content);
          if (found) charset = found[1]!.toLowerCase();
        }
        if (key === "description" && metaDescription === null && content) metaDescription = clip(content, MAX_FIELD_CHARS);
        else if (key === "robots" && robotsMeta === null && content) robotsMeta = clip(content.toLowerCase(), 200);
        else if (key === "viewport" && content) viewport = true;
        else if (key === "twitter:card" && twitterCard === null && content) twitterCard = clip(content, 60);
        else if (key.startsWith("og:") && content && !(key in openGraph) && Object.keys(openGraph).length < 20) {
          openGraph[key] = clip(content, MAX_FIELD_CHARS);
        }
        break;
      }
      case "link": {
        const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
        const href = (attrs.href ?? "").trim();
        if (rel.includes("canonical") && canonical === null && href) {
          canonical = resolveUrl(href, pageUrl)?.toString() ?? clip(href, MAX_FIELD_CHARS);
        }
        if (rel.includes("alternate") && attrs.hreflang && hreflang.length < 30) {
          const code = attrs.hreflang.trim().toLowerCase().slice(0, 20);
          if (code && !hreflang.includes(code)) hreflang.push(code);
        }
        break;
      }
      case "img":
        // A <noscript> fallback image is not one a reader sees.
        if (invisibleDepth > 0) break;
        imagesTotal += 1;
        if (!("alt" in attrs)) imagesMissingAlt += 1;
        break;
      case "a": {
        if (invisibleDepth > 0) break;
        const href = (attrs.href ?? "").trim();
        if (!href || href.startsWith("#")) break;
        const target = resolveUrl(href, pageUrl);
        if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) break;
        const host = target.hostname.toLowerCase().replace(/^www\./, "");
        if (pageHost && (host === pageHost || host.endsWith(`.${pageHost}`))) internal += 1;
        else external += 1;
        if ((attrs.rel ?? "").toLowerCase().split(/\s+/).includes("nofollow")) nofollow += 1;
        break;
      }
      default:
        break;
    }
  }
  closeHeading();

  const text = decodeEntities(visible.join(" "));
  const words = wordsOf(text);

  const frequency = new Map<string, number>();
  for (const raw of words) {
    const word = raw.toLowerCase();
    if (word.length < 3 || /^\d+$/.test(word) || STOPWORDS.has(word)) continue;
    frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  const topTerms = [...frequency.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TERMS)
    .map(([term, count]) => ({ term, count }));

  return {
    title,
    titleLength: title?.length ?? 0,
    metaDescription,
    metaDescriptionLength: metaDescription?.length ?? 0,
    canonical,
    robotsMeta,
    lang,
    viewport,
    charset,
    h1: headings.h1,
    h2: headings.h2,
    headingCounts,
    wordCount: words.length,
    images: { total: imagesTotal, missingAlt: imagesMissingAlt },
    links: { internal, external, nofollow },
    openGraph,
    twitterCard,
    structuredDataTypes: [...structured].sort().slice(0, 20),
    hreflang,
    topTerms,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** What no audit here measures. Said on every audit, so absence is never read as a pass. */
export const SEO_NOT_MEASURED: readonly string[] = Object.freeze([
  "Search rankings, search volume and keyword difficulty — JARVIS has no keyword data provider connected.",
  "Backlinks and domain authority.",
  "Page speed and Core Web Vitals.",
  "Content added by JavaScript — the page was read as HTML, without running its scripts.",
]);

export interface SeoAuditContext {
  /** The address the HTML came from, after redirects. */
  finalUrl: string;
  /** The address that was asked for. */
  requestedUrl: string;
  httpStatus: number;
  /** True when the page was cut short at the read limit. */
  truncated: boolean;
}

function sameAddress(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    try {
      const url = new URL(value);
      url.hash = "";
      return url.toString().replace(/\/$/, "").toLowerCase();
    } catch {
      return value.trim().replace(/\/$/, "").toLowerCase();
    }
  };
  return normalize(a) === normalize(b);
}

/**
 * Judge a page against the on-page basics.
 *
 * Every `finding` is a fact about this page. Every `recommendation` is advice.
 * The thresholds are the widely used rules of thumb (a title of roughly 30–60
 * characters, a description of roughly 70–160); they are guidance, and the
 * wording says "may", not "will".
 */
export function auditPage(facts: PageFacts, context: SeoAuditContext): SeoAudit {
  const checks: SeoCheck[] = [];
  const add = (check: SeoCheck): void => {
    checks.push(check);
  };

  // --- reachability ---------------------------------------------------------
  if (context.httpStatus >= 200 && context.httpStatus < 300) {
    add({ id: "http-status", label: "Page responds", severity: "pass", finding: `The page answered with HTTP ${context.httpStatus}.` });
  } else {
    add({
      id: "http-status",
      label: "Page responds",
      severity: "critical",
      finding: `The page answered with HTTP ${context.httpStatus}.`,
      recommendation: "A page that does not answer successfully cannot be indexed. Fix the response before anything else.",
    });
  }

  let https = false;
  try {
    https = new URL(context.finalUrl).protocol === "https:";
  } catch {
    https = false;
  }
  add(
    https
      ? { id: "https", label: "Served over HTTPS", severity: "pass", finding: "The page is served over HTTPS." }
      : {
          id: "https",
          label: "Served over HTTPS",
          severity: "warning",
          finding: "The page is served over plain HTTP.",
          recommendation: "Serve the page over HTTPS and redirect HTTP to it.",
        }
  );

  if (!sameAddress(context.requestedUrl, context.finalUrl)) {
    add({
      id: "redirect",
      label: "Redirect",
      severity: "info",
      finding: `The address redirected to ${context.finalUrl}.`,
    });
  }

  // --- indexing -------------------------------------------------------------
  const robots = facts.robotsMeta ?? "";
  if (/\bnoindex\b/.test(robots)) {
    add({
      id: "robots",
      label: "Indexing allowed",
      severity: "critical",
      finding: `The robots meta tag says "${facts.robotsMeta}".`,
      recommendation: "This asks search engines not to index the page. Remove noindex if the page should appear in search.",
    });
  } else if (/\bnofollow\b/.test(robots)) {
    add({
      id: "robots",
      label: "Indexing allowed",
      severity: "warning",
      finding: `The robots meta tag says "${facts.robotsMeta}".`,
      recommendation: "nofollow asks search engines not to follow this page's links. Remove it unless that is intended.",
    });
  } else {
    add({
      id: "robots",
      label: "Indexing allowed",
      severity: "pass",
      finding: facts.robotsMeta ? `The robots meta tag says "${facts.robotsMeta}".` : "No robots meta tag restricts indexing.",
    });
  }

  if (facts.canonical === null) {
    add({
      id: "canonical",
      label: "Canonical address",
      severity: "info",
      finding: "The page declares no canonical address.",
      recommendation: "Add a canonical link so duplicate addresses of this page are consolidated.",
    });
  } else if (sameAddress(facts.canonical, context.finalUrl)) {
    add({ id: "canonical", label: "Canonical address", severity: "pass", finding: "The canonical address is the page itself." });
  } else {
    add({
      id: "canonical",
      label: "Canonical address",
      severity: "info",
      finding: `The canonical address points to ${facts.canonical}.`,
      recommendation: "Search engines may index that address instead of this one. Confirm that is intended.",
    });
  }

  // --- title and description -----------------------------------------------
  if (facts.title === null) {
    add({
      id: "title",
      label: "Title",
      severity: "critical",
      finding: "The page has no title.",
      recommendation: "Add a title that says what the page is about, in roughly 30 to 60 characters.",
    });
  } else if (facts.titleLength < 30) {
    add({
      id: "title",
      label: "Title",
      severity: "warning",
      finding: `The title is ${facts.titleLength} characters: "${facts.title}".`,
      recommendation: "A short title leaves room unused. Roughly 30 to 60 characters is the usual guidance.",
    });
  } else if (facts.titleLength > 60) {
    add({
      id: "title",
      label: "Title",
      severity: "warning",
      finding: `The title is ${facts.titleLength} characters: "${clip(facts.title, 120)}".`,
      recommendation: "A long title may be cut off in search results. Roughly 30 to 60 characters is the usual guidance.",
    });
  } else {
    add({ id: "title", label: "Title", severity: "pass", finding: `The title is ${facts.titleLength} characters: "${facts.title}".` });
  }

  if (facts.metaDescription === null) {
    add({
      id: "meta-description",
      label: "Meta description",
      severity: "warning",
      finding: "The page has no meta description.",
      recommendation: "Add a description of roughly 70 to 160 characters; search engines often show it under the title.",
    });
  } else if (facts.metaDescriptionLength < 70) {
    add({
      id: "meta-description",
      label: "Meta description",
      severity: "info",
      finding: `The meta description is ${facts.metaDescriptionLength} characters.`,
      recommendation: "It is short. Roughly 70 to 160 characters is the usual guidance.",
    });
  } else if (facts.metaDescriptionLength > 160) {
    add({
      id: "meta-description",
      label: "Meta description",
      severity: "info",
      finding: `The meta description is ${facts.metaDescriptionLength} characters.`,
      recommendation: "It may be cut off in search results. Roughly 70 to 160 characters is the usual guidance.",
    });
  } else {
    add({
      id: "meta-description",
      label: "Meta description",
      severity: "pass",
      finding: `The meta description is ${facts.metaDescriptionLength} characters.`,
    });
  }

  // --- structure ------------------------------------------------------------
  const h1Count = facts.headingCounts.h1;
  if (h1Count === 0) {
    add({
      id: "h1",
      label: "Main heading",
      severity: "warning",
      finding: "The page has no H1 heading.",
      recommendation: "Add one H1 that states the page's subject.",
    });
  } else if (h1Count > 1) {
    add({
      id: "h1",
      label: "Main heading",
      severity: "info",
      finding: `The page has ${h1Count} H1 headings.`,
      recommendation: "One H1 per page is the usual guidance; use H2 for the sections under it.",
    });
  } else {
    add({ id: "h1", label: "Main heading", severity: "pass", finding: `The page has one H1: "${facts.h1[0] ?? ""}".` });
  }

  if (facts.wordCount < 300) {
    add({
      id: "content-length",
      label: "Content length",
      severity: "info",
      finding: `About ${facts.wordCount} words of text were read from the HTML.`,
      recommendation: "That is thin for a page meant to rank for a topic. If the page builds its content with JavaScript, this count misses it.",
    });
  } else {
    add({
      id: "content-length",
      label: "Content length",
      severity: "pass",
      finding: `About ${facts.wordCount} words of text were read from the HTML.`,
    });
  }

  // --- media, mobile, language ---------------------------------------------
  if (facts.images.total === 0) {
    add({ id: "image-alt", label: "Image descriptions", severity: "pass", finding: "The page has no images." });
  } else if (facts.images.missingAlt > 0) {
    add({
      id: "image-alt",
      label: "Image descriptions",
      severity: "warning",
      finding: `${facts.images.missingAlt} of ${facts.images.total} images have no alt attribute.`,
      recommendation: "Add alt text describing each meaningful image, and an empty alt for decorative ones.",
    });
  } else {
    add({
      id: "image-alt",
      label: "Image descriptions",
      severity: "pass",
      finding: `All ${facts.images.total} images have an alt attribute.`,
    });
  }

  add(
    facts.viewport
      ? { id: "viewport", label: "Mobile viewport", severity: "pass", finding: "A viewport meta tag is present." }
      : {
          id: "viewport",
          label: "Mobile viewport",
          severity: "warning",
          finding: "The page has no viewport meta tag.",
          recommendation: "Add one so the page scales properly on phones.",
        }
  );

  add(
    facts.lang
      ? { id: "lang", label: "Page language", severity: "pass", finding: `The page declares its language as "${facts.lang}".` }
      : {
          id: "lang",
          label: "Page language",
          severity: "info",
          finding: "The page does not declare its language.",
          recommendation: "Add a lang attribute to the html element.",
        }
  );

  // --- sharing and structured data -----------------------------------------
  const missingOg = ["og:title", "og:description", "og:image"].filter((key) => !(key in facts.openGraph));
  add(
    missingOg.length === 0
      ? { id: "open-graph", label: "Social sharing tags", severity: "pass", finding: "og:title, og:description and og:image are all present." }
      : {
          id: "open-graph",
          label: "Social sharing tags",
          severity: "info",
          finding: `Missing ${missingOg.join(", ")}.`,
          recommendation: "These control how the page looks when it is shared on social platforms.",
        }
  );

  add(
    facts.structuredDataTypes.length > 0
      ? {
          id: "structured-data",
          label: "Structured data",
          severity: "pass",
          finding: `Structured data is present: ${facts.structuredDataTypes.join(", ")}.`,
        }
      : {
          id: "structured-data",
          label: "Structured data",
          severity: "info",
          finding: "No JSON-LD structured data was found.",
          recommendation: "Structured data can make a page eligible for richer search results.",
        }
  );

  if (context.truncated) {
    add({
      id: "truncated",
      label: "Page size",
      severity: "info",
      finding: "The page was larger than the read limit, so only the first part of it was audited.",
    });
  }

  const counts: Record<SeoCheckSeverity, number> = { pass: 0, info: 0, warning: 0, critical: 0 };
  for (const check of checks) counts[check.severity] += 1;

  return { facts, checks, counts, notMeasured: [...SEO_NOT_MEASURED] };
}

/** One line that says what an audit found, built from its counts. */
export function seoAuditHeadline(audit: SeoAudit): string {
  const { critical, warning, info, pass } = audit.counts;
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (warning > 0) parts.push(`${warning} warning${warning === 1 ? "" : "s"}`);
  if (info > 0) parts.push(`${info} note${info === 1 ? "" : "s"}`);
  parts.push(`${pass} passed`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function shown(value: string | null): string {
  return value === null || value.length === 0 ? "(none)" : clip(value, 160);
}

function topTermList(facts: PageFacts): string {
  return facts.topTerms.length === 0 ? "(none)" : facts.topTerms.slice(0, 8).map((t) => t.term).join(", ");
}

/**
 * The differences between two sets of page facts.
 *
 * Used both ways round: the user's page against a competitor's, and one page
 * against an earlier read of itself. `leftName` and `rightName` are how the
 * two are referred to in the notes. Only fields that actually differ are
 * returned — a comparison that lists everything says nothing.
 */
export function comparePageFacts(
  left: PageFacts,
  right: PageFacts,
  names: { left: string; right: string }
): PageDifference[] {
  const differences: PageDifference[] = [];
  const push = (field: string, l: string, r: string, note: string): void => {
    if (l !== r) differences.push({ field, left: l, right: r, note });
  };

  push("Title", shown(left.title), shown(right.title), `${names.left} and ${names.right} use different titles.`);
  push(
    "Meta description",
    shown(left.metaDescription),
    shown(right.metaDescription),
    `The meta descriptions differ.`
  );
  push("Main heading (H1)", shown(left.h1[0] ?? null), shown(right.h1[0] ?? null), "The main headings differ.");

  if (left.wordCount !== right.wordCount) {
    const longer = left.wordCount > right.wordCount ? names.left : names.right;
    differences.push({
      field: "Words on the page",
      left: String(left.wordCount),
      right: String(right.wordCount),
      note: `${longer} has more text in its HTML.`,
    });
  }

  push(
    "Section headings (H2)",
    String(left.headingCounts.h2),
    String(right.headingCounts.h2),
    "The number of H2 sections differs."
  );
  push(
    "Images",
    `${left.images.total} (${left.images.missingAlt} without alt)`,
    `${right.images.total} (${right.images.missingAlt} without alt)`,
    "Image counts or alt coverage differ."
  );
  push(
    "Structured data",
    left.structuredDataTypes.join(", ") || "(none)",
    right.structuredDataTypes.join(", ") || "(none)",
    "The structured data declared differs."
  );
  push(
    "Social sharing tags",
    Object.keys(left.openGraph).sort().join(", ") || "(none)",
    Object.keys(right.openGraph).sort().join(", ") || "(none)",
    "The Open Graph tags present differ."
  );
  push("Most frequent words", topTermList(left), topTermList(right), "The words used most often differ.");
  push("Indexing directive", shown(left.robotsMeta), shown(right.robotsMeta), "The robots meta tags differ.");

  return differences;
}

/** What a competitor analysis never contains. */
export const COMPETITOR_NOT_MEASURED: readonly string[] = Object.freeze([
  "The competitor's traffic, rankings, ad spend or audience — none of that is on a web page.",
  "Their social media activity and their advertising — JARVIS has no data source for either.",
  "Content added by JavaScript — the page was read as HTML, without running its scripts.",
]);

/**
 * Assemble a competitor analysis from page facts that were already read.
 *
 * `previous` is the facts from the last saved read of the same competitor
 * page, when there is one.
 */
export function buildCompetitorAnalysis(input: {
  competitor: PageFacts;
  own: PageFacts | null;
  previous: { facts: PageFacts; fetchedAt: string } | null;
  /** Why the user's own page could not be read, when it was asked for and was not. */
  ownPageError?: string | null;
}): CompetitorAnalysis {
  return {
    competitor: input.competitor,
    own: input.own,
    ownPageError: input.own ? null : (input.ownPageError ?? null),
    comparedWithOwn: input.own
      ? comparePageFacts(input.own, input.competitor, { left: "Your page", right: "The competitor's page" })
      : [],
    changesSinceLast: input.previous
      ? comparePageFacts(input.previous.facts, input.competitor, { left: "The earlier read", right: "The page now" })
      : [],
    previousFetchedAt: input.previous?.fetchedAt ?? null,
    notMeasured: [...COMPETITOR_NOT_MEASURED],
  };
}

export function competitorHeadline(analysis: CompetitorAnalysis): string {
  const parts: string[] = [];
  if (analysis.ownPageError) parts.push("your page could not be read");
  if (analysis.own) {
    parts.push(
      analysis.comparedWithOwn.length === 0
        ? "no differences from your page in the fields compared"
        : `${analysis.comparedWithOwn.length} difference${analysis.comparedWithOwn.length === 1 ? "" : "s"} from your page`
    );
  }
  if (analysis.previousFetchedAt) {
    parts.push(
      analysis.changesSinceLast.length === 0
        ? "unchanged since the last read"
        : `${analysis.changesSinceLast.length} change${analysis.changesSinceLast.length === 1 ? "" : "s"} since the last read`
    );
  } else {
    parts.push("first read of this page");
  }
  return parts.join("; ");
}
