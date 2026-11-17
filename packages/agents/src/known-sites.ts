// ---------------------------------------------------------------------------
// Phase 19 — well-known websites a person may name WITHOUT a link
// ("Amazon kholo aur iPhone 17 ka price check karo").
//
// One table, two readers: the routing heuristic (`looksLikeBrowsingRequest`)
// recognises the NAMES, and the Browser Agent's prompt is told the ADDRESSES,
// so the model never has to invent a URL from memory.
//
// A CLOSED list, like the verbs beside it: adding a site is a decision with a
// test. It authorizes nothing. Where the browser may go is decided below the
// tools (the navigation policy and the egress proxy), so a wrong address here
// is refused there like any other.
//
// `search` carries `{query}`, replaced by the URL-encoded words to look for.
// A site with no confident search address has none, and the agent opens its
// home page instead of guessing one.
//
// The default region is India (.in) because that is where this deployment
// runs; a person who names another country's site by address gets that site.
// ---------------------------------------------------------------------------

export interface KnownSite {
  id: string;
  /** Regex SOURCE for how a person writes the name. Matched case-insensitively, as whole words. */
  pattern: string;
  home: string;
  search?: string;
}

export const KNOWN_SITES: readonly KnownSite[] = Object.freeze([
  { id: "amazon", pattern: "amazon(?:\\.(?:in|com))?", home: "https://www.amazon.in", search: "https://www.amazon.in/s?k={query}" },
  { id: "flipkart", pattern: "flipkart(?:\\.com)?", home: "https://www.flipkart.com", search: "https://www.flipkart.com/search?q={query}" },
  { id: "snapdeal", pattern: "snapdeal(?:\\.com)?", home: "https://www.snapdeal.com", search: "https://www.snapdeal.com/search?keyword={query}" },
  { id: "myntra", pattern: "myntra(?:\\.com)?", home: "https://www.myntra.com" },
  { id: "croma", pattern: "croma(?:\\.com)?", home: "https://www.croma.com" },
  { id: "ebay", pattern: "ebay(?:\\.com)?", home: "https://www.ebay.com", search: "https://www.ebay.com/sch/i.html?_nkw={query}" },
  { id: "walmart", pattern: "walmart(?:\\.com)?", home: "https://www.walmart.com", search: "https://www.walmart.com/search?q={query}" },
  { id: "bestbuy", pattern: "best\\s?buy(?:\\.com)?", home: "https://www.bestbuy.com", search: "https://www.bestbuy.com/site/searchpage.jsp?st={query}" },
  { id: "wikipedia", pattern: "wikipedia(?:\\.org)?", home: "https://en.wikipedia.org", search: "https://en.wikipedia.org/w/index.php?search={query}" },
  { id: "youtube", pattern: "youtube(?:\\.com)?", home: "https://www.youtube.com", search: "https://www.youtube.com/results?search_query={query}" },
]);

/** The names, as one regex alternation (no capture groups of their own that matter to callers). */
export const KNOWN_SITE_NAMES = KNOWN_SITES.map((site) => `(?:${site.pattern})`).join("|");

/** The Browser Agent's prompt block: where each named site lives and how to search it. */
export function knownSitesPromptBlock(): string {
  const lines = KNOWN_SITES.map((site) =>
    site.search ? `- ${site.id}: home ${site.home} — search ${site.search}` : `- ${site.id}: home ${site.home} (no search address: open the home page)`
  );
  return [
    "=== SITES THE USER MAY NAME WITHOUT A LINK ===",
    "When the user names one of these sites and gives no address, use exactly these addresses. Do not invent or recall other ones.",
    "In a search address, replace {query} with the words to look for, URL-encoded (spaces as %20).",
    ...lines,
  ].join("\n");
}
