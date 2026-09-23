// ---------------------------------------------------------------------------
// The Skill contract — Skill System V1, Phase S1.
//
// WHAT A SKILL IS, AND WHAT IT IS NOT.
//
//   TOOL         "what single operation can I execute?"   -> ITool
//   SKILL        "what OUTCOME can I provide?"            -> this file
//   AGENT        "how do I reason about this domain?"     -> AGENT_POLICIES
//   INTEGRATION  "which external system am I connected to?" -> INTEGRATION_CATALOG
//   PROVIDER     "which implementation performs the call?"  -> packages/meta-graph, …
//   WORKFLOW     "which sequence produces the outcome?"      -> not built
//
// A SKILL IS METADATA, NOT AN ENGINE. There is deliberately no `execute()` on
// anything in this file, and nothing here imports a registry, an executor or a
// provider. A skill names an outcome and the tools behind it; running one goes
// the way everything else already goes:
//
//   Skill -> Planner / Agent -> ToolExecutor -> Tool
//
// Adding a second path would put work outside the permission check, the
// approval gate, the shutdown gate, the deadline and the audit row - every one
// of which lives in ToolExecutor and nowhere else.
//
// THIS IS A PROMOTION, NOT A NEW MODEL. `capability-presentation.ts` already
// grouped live capabilities into outcomes with a title, a summary and derived
// example phrasings, in order to fix the "read 34 bullet points aloud" bug. It
// had everything a skill needs except a name and a type. This file gives it
// both; it does not introduce a second list, and `SkillDefinition` is shaped to
// the fields that file ALREADY uses, so promoting it required no rename.
//
// NOTHING HERE IS PERSISTED. Availability, integrations and counts are derived
// per request from the live report, exactly as capability already is. A stored
// availability would be a claim that goes stale the moment a token expires.
// ---------------------------------------------------------------------------

import type { CapabilityAvailability } from "./capability.js";

/**
 * One thing a user can ask for, gated on the tool that makes it true.
 *
 * `requires` is an EXACT registry tool id. A phrase whose tool is not usable
 * right now is dropped rather than shown - which is how an honest skill shrinks
 * instead of over-promising.
 */
export interface SkillExample {
  requires: string;
  text: string;
}

/**
 * A code-defined outcome, and the tools that deliver it.
 *
 * MEMBERSHIP IS CODE, NOT DATA, AND THAT IS THE SECURITY PROPERTY. A skill
 * naming a tool does NOT authorise it: the agent allowlist decides that, at
 * compile time, and `SkillView` is built only from capabilities that already
 * passed it. Discovery is not authorization - a future learned or MCP-sourced
 * relationship must not become executable by appearing here.
 *
 * Field names match the existing goal-group rules exactly, because this type
 * was fitted to them rather than the other way round.
 */
export interface SkillDefinition {
  /** Stable slug. Internal; never shown to a user. */
  id: string;
  /** The outcome, in the user's words. */
  title: string;
  /** One sentence on what this skill gets done. */
  summary: string;
  /** Tool-id prefixes owned by this skill. */
  prefixes: readonly string[];
  /** Exact tool ids owned by this skill. Checked BEFORE prefixes. */
  exact?: readonly string[];
  /** Request phrasings, each gated on a tool being usable. */
  phrases: readonly SkillExample[];
}

/**
 * A tool deliberately kept OUT of the user-facing skill catalogue.
 *
 * Existing and being callable is not the same as being an outcome a user asks
 * for. Introspection ("what are you?"), JARVIS's own work queue and test
 * fixtures are all real, authorized and useful, and none of them is something
 * a person asks a skill to achieve.
 *
 * Recorded rather than left implicit so that "no skill owns this" is always a
 * decision with a reason attached, and a NEW orphan — which is far more likely
 * to be a mistake — fails a test instead of passing unnoticed.
 */
export interface UnlistedTool {
  /** Exact registry tool id. */
  id: string;
  /** Why it is not a skill member. Never "TODO". */
  reason: string;
}

/**
 * A skill as it stands RIGHT NOW, for one user.
 *
 * Every field below is derived at read time from a live `CapabilityReport`.
 * None is stored, and none may be written by hand.
 */
export interface SkillView {
  id: string;
  title: string;
  summary: string;

  /**
   * The member tools that are actually reachable for this user.
   *
   * Resolved from the live report, which `CapabilityService` has already
   * filtered to the agent allowlist - so an unauthorised tool cannot appear
   * here even if a definition names it.
   */
  toolIds: readonly string[];

  /** Which integrations gate this skill, derived from its members. */
  integrations: readonly string[];

  /**
   * The skill's headline state: the state of its MOST usable member.
   *
   * WHY THE BEST MEMBER AND NOT THE WEAKEST. A skill is an outcome, and an
   * outcome with four working tools and one unconnected provider is partly
   * available, not unavailable. Reporting the weakest member would tell a user
   * "I cannot look at your campaigns" because one write tool needs a
   * reconnect - which is false and unhelpful.
   *
   * This is the semantics the capability briefing already uses: a group is
   * built from USABLE capabilities and appears when at least one exists. The
   * degradation is not hidden - it is carried in `unavailableCount` and
   * `blockedBy`, so a caller can say "I can do most of this, except …".
   */
  availability: CapabilityAvailability;

  /** Members that run on request (EXECUTABLE or REQUIRES_CONFIRMATION). */
  usableCount: number;
  /** Of those, how many stop for an explicit confirmation first. */
  approvalCount: number;
  /** Members that cannot run right now, for any reason. */
  unavailableCount: number;
  /** Every member the definition claims, usable or not. */
  totalCount: number;

  /**
   * Distinct, plain-English reasons some members cannot run. Empty when the
   * skill is whole. Never contains provider internals or credentials.
   */
  blockedBy: readonly string[];

  /** Things the user can say right now, each backed by a usable tool. */
  youCanAsk: readonly string[];
}
