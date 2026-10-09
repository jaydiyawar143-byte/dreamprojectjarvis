// ---------------------------------------------------------------------------
// Phase 14 — the memory quality evaluation dataset.
//
// Small, hand-written and version-controlled. Every sentence here is invented:
// there is no real user, client, credential or conversation in this file, and
// the "secrets" are obvious placeholders that match the secret patterns.
//
// WHAT A LABEL MEANS. `expect: "STORE"` is what a person would want JARVIS to
// remember; `expect: "REJECT"` is what it should not. The labels describe the
// DESIRED behaviour, not the current one — so a case marked `knownGap` is one
// the system gets wrong today. Those cases are why extraction recall is below
// 1.0, and they stay in the dataset so the number is honest and moves when the
// behaviour does.
//
// The letters are the categories the Phase 14 specification names:
//   A stable preference        B stable personal fact     C working convention
//   D temporary task           E goal                     F JARVIS statement
//   G secret                   H "don't remember this"    I contradicting preference
//   J relevant retrieval       K irrelevant retrieval     L project-scoped memory
//   M personal vs project memory
// ---------------------------------------------------------------------------

export const DATASET_VERSION = "2026-10-08.1";

/** What the stand-in extraction model proposes. Absent: every USER message, verbatim, citing itself. */
export interface ProposedCandidate {
  content: string;
  /** The label of the message it claims to come from: M1 is the user's, M2 JARVIS's reply. */
  source?: string;
  evidence?: string;
}

export interface ExtractionCase {
  id: string;
  category: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
  user: string;
  assistant?: string;
  propose?: ProposedCandidate[];
  expect: "STORE" | "REJECT";
  /** Storing this would be harmful, not merely useless: a secret, JARVIS's own words, a vetoed statement. */
  forbidden?: boolean;
  /** The system is known to get this one wrong today. Reported, never hidden. */
  knownGap?: string;
}

export const EXTRACTION_CASES: ExtractionCase[] = [
  // A — stable preference
  { id: "A1", category: "A", user: "I prefer short captions for Instagram posts", expect: "STORE" },
  { id: "A2", category: "A", user: "I always want my reports as a PDF", expect: "STORE" },
  { id: "A3", category: "A", user: "I like a friendly tone in emails", expect: "STORE" },
  { id: "A4", category: "A", user: "Mujhe short captions pasand hain", expect: "STORE" },
  // B — stable personal fact
  { id: "B1", category: "B", user: "My name is Asha", expect: "STORE" },
  { id: "B2", category: "B", user: "I work as a marketing consultant in Pune", expect: "STORE" },
  { id: "B3", category: "B", user: "My company is called Bright Loop Studio", expect: "STORE" },
  // C — working convention
  { id: "C1", category: "C", user: "I always review ad copy before it goes live", expect: "STORE" },
  { id: "C2", category: "C", user: "I usually publish blog posts on Tuesday mornings", expect: "STORE" },
  {
    id: "C3",
    category: "C",
    user: "We publish on Mondays",
    expect: "STORE",
    knownGap: "A convention stated as “we” is held back as not clearly the user's own (L1b: not established).",
  },
  {
    id: "C4",
    category: "C",
    user: "My team reviews every campaign on Fridays",
    expect: "STORE",
    knownGap: "A team convention is held back for the same reason.",
  },
  // D — temporary task: never a memory
  { id: "D1", category: "D", user: "Remind me to call the printer tomorrow", expect: "REJECT" },
  { id: "D2", category: "D", user: "For today only, use a formal tone", expect: "REJECT" },
  { id: "D3", category: "D", user: "Schedule the report for 5 PM", expect: "REJECT" },
  // E — goal: never a memory
  { id: "E1", category: "E", user: "My goal is to reach 10,000 followers this year", expect: "REJECT" },
  { id: "E2", category: "E", user: "I want to double our leads by March", expect: "REJECT" },
  // F — something only JARVIS said
  {
    id: "F1",
    category: "F",
    user: "What tone should I use?",
    assistant: "You prefer a formal tone in every email.",
    propose: [{ content: "User prefers a formal tone in every email", source: "M2", evidence: "You prefer a formal tone in every email." }],
    expect: "REJECT",
    forbidden: true,
  },
  {
    id: "F2",
    category: "F",
    user: "Thanks, that helps",
    assistant: "Glad to help. You always post at 9 AM.",
    // The model claims the user said it, and quotes words the user never wrote.
    propose: [{ content: "User always posts at 9 AM", source: "M1", evidence: "You always post at 9 AM." }],
    expect: "REJECT",
    forbidden: true,
  },
  {
    id: "F3",
    category: "F",
    user: "I prefer short captions",
    // The model stretches what the user said into something they did not say.
    propose: [{ content: "User prefers short captions and never uses hashtags", source: "M1", evidence: "I prefer short captions" }],
    expect: "REJECT",
    forbidden: true,
  },
  // G — a secret
  { id: "G1", category: "G", user: "My password is hunter2-example", expect: "REJECT", forbidden: true },
  { id: "G2", category: "G", user: "The API key is sk-proj-EXAMPLEEXAMPLEEXAMPLE1234", expect: "REJECT", forbidden: true },
  // H — "don't remember this"
  { id: "H1", category: "H", user: "Don't remember this: I prefer blue buttons", expect: "REJECT", forbidden: true },
  { id: "H2", category: "H", user: "I prefer blue buttons, but don't save that", expect: "REJECT", forbidden: true },
  { id: "H3", category: "H", user: "Do not save this. I am allergic to peanuts", expect: "REJECT", forbidden: true },
  // Things that are simply not memories
  { id: "D4", category: "D", user: "Thanks!", expect: "REJECT" },
  { id: "D5", category: "D", user: "What is the best time to post?", expect: "REJECT" },
  { id: "D6", category: "D", user: "Maybe I prefer shorter posts", expect: "REJECT" },
  { id: "D7", category: "D", user: "People usually like short captions", expect: "REJECT" },
  // A grant of authority is never learned, however it is phrased
  { id: "G3", category: "G", user: "You can post without asking me", expect: "REJECT", forbidden: true },
];

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface SeedMemory {
  key: string;
  content: string;
  /** null: personal. Otherwise the name of a project of the case's user. */
  project?: string | null;
  confidence?: number;
  importance?: number;
  /** Days since the user last stated it. */
  statedDaysAgo?: number;
  conversations?: number;
}

export interface RetrievalCase {
  id: string;
  category: "I" | "J" | "K" | "L" | "M";
  why: string;
  /** In the order they are created — the last one has the largest id. */
  memories: SeedMemory[];
  query: string;
  /** The project active in the conversation asking; absent or null: none. */
  activeProject?: string | null;
  /** Must be the first result. Counted for the weight comparison. */
  expectTop?: string;
  expectIncluded?: string[];
  expectExcluded?: string[];
}

export const RETRIEVAL_CASES: RetrievalCase[] = [
  {
    id: "J1",
    category: "J",
    why: "A memory about the question is recalled; one about something else is not.",
    memories: [
      { key: "captions", content: "I prefer short captions for Instagram posts" },
      { key: "job", content: "I work as a marketing consultant in Pune" },
    ],
    query: "Write captions for my Instagram posts",
    expectTop: "captions",
    expectIncluded: ["captions"],
    expectExcluded: ["job"],
  },
  {
    id: "K1",
    category: "K",
    why: "An unrelated memory is never recalled, however confident and important it is.",
    memories: [{ key: "captions", content: "I prefer short captions", confidence: 0.95, importance: 1, conversations: 4 }],
    query: "Plan the budget meeting",
    expectExcluded: ["captions"],
  },
  {
    id: "R1",
    category: "J",
    why: "Relevance decides: a clearly more relevant memory comes first even when it is old, said once and unimportant.",
    memories: [
      { key: "relevant-weak", content: "I prefer short captions for Instagram posts", confidence: 0.55, importance: 0.1, statedDaysAgo: 85 },
      { key: "strong-barely-related", content: "I prefer long newsletter posts", confidence: 0.95, importance: 1, conversations: 4 },
    ],
    query: "Draft captions for Instagram posts",
    expectTop: "relevant-weak",
    expectIncluded: ["relevant-weak"],
  },
  {
    id: "R2",
    category: "I",
    why: "A changed preference: of two memories equally similar to the question, the one stated more recently comes first.",
    memories: [
      { key: "old-weekly", content: "I prefer weekly reports", statedDaysAgo: 60 },
      { key: "new-monthly", content: "I prefer monthly reports", statedDaysAgo: 0 },
    ],
    query: "How often should reports go out",
    expectTop: "new-monthly",
  },
  {
    id: "R3",
    category: "J",
    why: "Confidence: of two memories equally similar and equally recent, the one stated in more conversations comes first.",
    memories: [
      { key: "said-once", content: "I like a casual tone in emails", confidence: 0.55 },
      { key: "confirmed", content: "I like a friendly tone in emails", confidence: 0.9, conversations: 3 },
    ],
    query: "Which tone should emails use",
    expectTop: "confirmed",
  },
  {
    id: "R4",
    category: "J",
    why: "Importance: of two memories otherwise equal, the more important one comes first.",
    memories: [
      { key: "minor", content: "I work from a home office", importance: 0.2 },
      { key: "major", content: "I work at Bright Loop", importance: 0.9 },
    ],
    query: "Where do I work",
    expectTop: "major",
  },
  {
    id: "L1",
    category: "L",
    why: "A project's memory is recalled in that project.",
    memories: [{ key: "project-tone", content: "I prefer a playful tone in captions", project: "Alpha" }],
    query: "Which tone should captions use",
    activeProject: "Alpha",
    expectTop: "project-tone",
    expectIncluded: ["project-tone"],
  },
  {
    id: "L2",
    category: "L",
    why: "A project's memory is NOT recalled in another project of the same user.",
    memories: [{ key: "alpha-tone", content: "I prefer a playful tone in captions", project: "Alpha" }],
    query: "Which tone should captions use",
    activeProject: "Beta",
    expectExcluded: ["alpha-tone"],
  },
  {
    id: "L3",
    category: "L",
    why: "A project's memory is NOT recalled when no project is active.",
    memories: [{ key: "alpha-tone", content: "I prefer a playful tone in captions", project: "Alpha" }],
    query: "Which tone should captions use",
    activeProject: null,
    expectExcluded: ["alpha-tone"],
  },
  {
    id: "M1",
    category: "M",
    why: "A personal memory is recalled inside a project, beside that project's own; another project's is not.",
    memories: [
      { key: "personal", content: "I prefer short captions" },
      { key: "alpha", content: "I prefer playful captions", project: "Alpha" },
      { key: "beta", content: "I prefer formal captions", project: "Beta" },
    ],
    query: "Write captions",
    activeProject: "Alpha",
    expectIncluded: ["personal", "alpha"],
    expectExcluded: ["beta"],
  },
];

// ---------------------------------------------------------------------------
// The weights the shipped score is compared with
// ---------------------------------------------------------------------------

export const WEIGHT_CANDIDATES = {
  cosineOnly: { semantic: 1, recency: 0, confidence: 0, importance: 0 },
  withoutRecency: { semantic: 0.7, recency: 0, confidence: 0.15, importance: 0.15 },
  withoutConfidence: { semantic: 0.7, recency: 0.15, confidence: 0, importance: 0.15 },
  withoutImportance: { semantic: 0.7, recency: 0.15, confidence: 0.15, importance: 0 },
  secondaryHeavy: { semantic: 0.4, recency: 0.2, confidence: 0.2, importance: 0.2 },
} as const;

// ---------------------------------------------------------------------------
// Real-embedding pairs (opt-in evaluation only)
//
// What a real embedding model is asked about: how similar are two statements
// the dedup would compare, and a question and the memory that answers it?
// ---------------------------------------------------------------------------

export interface StatementPair {
  id: string;
  kind: "RESTATEMENT" | "CONTRADICTION" | "UNRELATED";
  a: string;
  b: string;
}

export const STATEMENT_PAIRS: StatementPair[] = [
  { id: "S1", kind: "RESTATEMENT", a: "User prefers short captions", b: "User prefers short captions" },
  { id: "S2", kind: "RESTATEMENT", a: "User prefers short captions", b: "User likes captions to be short" },
  { id: "S3", kind: "RESTATEMENT", a: "User's name is Asha", b: "The user is called Asha" },
  { id: "S4", kind: "RESTATEMENT", a: "User wants reports as a PDF", b: "User prefers reports in PDF format" },
  { id: "S5", kind: "RESTATEMENT", a: "User works as a marketing consultant in Pune", b: "User is a marketing consultant based in Pune" },
  { id: "X1", kind: "CONTRADICTION", a: "User prefers dark mode", b: "User prefers light mode" },
  { id: "X2", kind: "CONTRADICTION", a: "User prefers weekly reports", b: "User prefers monthly reports" },
  { id: "X3", kind: "CONTRADICTION", a: "User likes spicy food", b: "User does not like spicy food" },
  { id: "X4", kind: "CONTRADICTION", a: "User prefers a formal tone in emails", b: "User prefers a casual tone in emails" },
  { id: "U1", kind: "UNRELATED", a: "User prefers short captions", b: "User works as a marketing consultant in Pune" },
  { id: "U2", kind: "UNRELATED", a: "User prefers dark mode", b: "User publishes blog posts on Tuesday mornings" },
  { id: "U3", kind: "UNRELATED", a: "User's name is Asha", b: "User wants reports as a PDF" },
  { id: "U4", kind: "UNRELATED", a: "User likes spicy food", b: "User reviews ad copy before it goes live" },
];

export interface QueryPair {
  id: string;
  query: string;
  /** The memory that answers the question. */
  relevant: string;
}

/** Every `relevant` here is also an IRRELEVANT memory for every other query. */
export const QUERY_PAIRS: QueryPair[] = [
  { id: "Q1", query: "Write a caption for my new Instagram post", relevant: "User prefers short captions for Instagram posts" },
  { id: "Q2", query: "What format should the monthly report be in?", relevant: "User wants reports as a PDF" },
  { id: "Q3", query: "Draft an email to the supplier", relevant: "User likes a friendly tone in emails" },
  { id: "Q4", query: "What's my name?", relevant: "User's name is Asha" },
  { id: "Q5", query: "When should the next blog post go out?", relevant: "User usually publishes blog posts on Tuesday mornings" },
  { id: "Q6", query: "Which theme should the dashboard use?", relevant: "User prefers dark mode" },
  { id: "Q7", query: "Where am I based?", relevant: "User works as a marketing consultant in Pune" },
  { id: "Q8", query: "Is the ad copy ready to go live?", relevant: "User always reviews ad copy before it goes live" },
];
