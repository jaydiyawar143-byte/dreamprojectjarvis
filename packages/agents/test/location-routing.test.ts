// ---------------------------------------------------------------------------
// Natural-language routing to the Location agent.
//
// Two obligations pull against each other here, and both are pinned:
//
//   1. The map phrasings from the spec must reach the location agent — in
//      English, in Hindi and in the Hinglish mixture people actually type.
//
//   2. Nothing that used to route elsewhere may start routing here. The Meta,
//      Google Ads, automation, WhatsApp, knowledge and browser heuristics were
//      tuned over several sprints and are load-bearing; a greedy location
//      pattern would quietly steal traffic from them, and the symptom would be
//      an agent that cannot help rather than an error anyone notices.
//
// The regression half is the reason `route` is matched only as a whole word and
// `show <place>` is deliberately NOT a signal.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { rankAgentCandidates } from "../src/agent-router.js";
import { AGENT_IDS, AGENT_POLICIES, MAPS_TOOLS, isToolAllowed } from "../src/agent-policy.js";

/** The top-ranked candidate for a message. */
function top(message: string): string {
  return rankAgentCandidates(message)[0]!.agentId;
}

function candidates(message: string): string[] {
  return rankAgentCandidates(message).map((c) => c.agentId);
}

describe("map and route phrasings reach the location agent", () => {
  it("routes the spec's English examples", () => {
    expect(top("show me the route from Balaghat to Gondia")).toBe(AGENT_IDS.location);
    expect(top("find restaurants near me")).toBe(AGENT_IDS.location);
    expect(top("find the nearest airport")).toBe(AGENT_IDS.location);
    expect(top("search Google Maps for cafes near me")).toBe(AGENT_IDS.location);
    expect(top("how far is Gondia from Balaghat?")).toBe(AGENT_IDS.location);
  });

  it("routes the spec's Hindi and Hinglish examples", () => {
    expect(top("Balaghat se Gondia ka route dikhao")).toBe(AGENT_IDS.location);
    expect(top("Balaghat se Gondia kitna distance hai?")).toBe(AGENT_IDS.location);
    expect(top("Meri current location se Gondia ka route dikhao")).toBe(AGENT_IDS.location);
    expect(top("mere paas koi acha restaurant hai kya")).toBe(AGENT_IDS.location);
  });

  it("routes travel-mode phrasings", () => {
    expect(top("driving route from Balaghat to Gondia")).toBe(AGENT_IDS.location);
    expect(top("walking route to the station")).toBe(AGENT_IDS.location);
    expect(top("public transport route to the airport")).toBe(AGENT_IDS.location);
  });

  it("routes an explicit request to show something on the map", () => {
    expect(top("show Gondia on the map")).toBe(AGENT_IDS.location);
    expect(top("Gondia ko map par dikhao")).toBe(AGENT_IDS.location);
  });

  it("routes travel-time questions", () => {
    expect(top("what is the travel time to Nagpur")).toBe(AGENT_IDS.location);
    expect(top("how long does it take to drive to Nagpur")).toBe(AGENT_IDS.location);
  });
});

// ---------------------------------------------------------------------------

describe("existing routing is not disturbed", () => {
  it("leaves the Meta Ads heuristic alone", () => {
    expect(top("Meta campaign check karo")).toBe(AGENT_IDS.metaAds);
    expect(top("Facebook ads ka ROAS batao")).toBe(AGENT_IDS.metaAds);
    expect(top("CPA kyun badh raha hai?")).toBe(AGENT_IDS.metaAds);
  });

  it("leaves Google Ads alone — 'Google Maps' is not 'Google Ads'", () => {
    expect(top("Google Ads campaign analyze karo")).toBe(AGENT_IDS.googleAds);
    expect(top("show my adwords spend")).toBe(AGENT_IDS.googleAds);
  });

  it("leaves the explicitly-named systems ranked above location", () => {
    // "route the workflow" contains `route`, and must still go to automation.
    expect(top("route the onboarding workflow through n8n")).toBe(AGENT_IDS.automation);
    expect(top("reply to that WhatsApp message")).toBe(AGENT_IDS.communication);
  });

  it("leaves knowledge and browser alone", () => {
    expect(top("what does our refund policy document say?")).toBe(AGENT_IDS.knowledge);
    expect(top("open https://example.com and read it")).toBe(AGENT_IDS.browser);
  });

  it("does NOT treat a bare place name as a map request", () => {
    // Indistinguishable from a campaign named Gondia. Routing on a proper noun
    // would make the router guess on every message.
    expect(top("show Gondia")).not.toBe(AGENT_IDS.location);
    expect(top("tell me about Balaghat")).not.toBe(AGENT_IDS.location);
  });

  it("does not match 'route' inside another word", () => {
    expect(candidates("the request was rerouted internally")).not.toContain(AGENT_IDS.location);
    expect(candidates("check the router logs")).not.toContain(AGENT_IDS.location);
  });

  it("always ends with the general assistant as a terminal fallback", () => {
    const list = candidates("Balaghat se Gondia ka route dikhao");
    expect(list[list.length - 1]).toBe(AGENT_IDS.general);
  });
});

// ---------------------------------------------------------------------------

describe("location policy", () => {
  it("holds every maps tool and nothing else", () => {
    const policy = AGENT_POLICIES[AGENT_IDS.location]!;
    expect([...policy.allowedTools].sort()).toEqual([...MAPS_TOOLS].sort());
  });

  it("is read-only", () => {
    const policy = AGENT_POLICIES[AGENT_IDS.location]!;
    expect(policy.requiredPermissions).toEqual(["read"]);
  });

  it("cannot reach an ads or messaging tool", () => {
    const allowed = AGENT_POLICIES[AGENT_IDS.location]!.allowedTools;
    for (const forbidden of ["meta.campaign.pause", "whatsapp.send", "n8n.trigger", "google.insights"]) {
      expect(isToolAllowed(forbidden, allowed)).toBe(false);
    }
  });

  it("resolves a maps tool by its sanitized spelling too", () => {
    const allowed = AGENT_POLICIES[AGENT_IDS.location]!.allowedTools;
    // The model sees "maps-route"; the allowlist holds "maps.route".
    expect(isToolAllowed("maps-route", allowed)).toBe(true);
    expect(isToolAllowed("maps.route", allowed)).toBe(true);
  });

  it("gives the general assistant the maps tools as well", () => {
    // A distance question arrives mid-conversation at least as often as it
    // arrives alone; the fallback agent going tool-less would make it guess.
    const allowed = AGENT_POLICIES[AGENT_IDS.general]!.allowedTools;
    for (const id of MAPS_TOOLS) {
      expect(isToolAllowed(id, allowed)).toBe(true);
    }
  });

  it("does not grant maps tools to unrelated specialised agents", () => {
    for (const agentId of [AGENT_IDS.metaAds, AGENT_IDS.communication, AGENT_IDS.automation]) {
      const allowed = AGENT_POLICIES[agentId]!.allowedTools;
      expect(isToolAllowed("maps.current.location", allowed)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe("Hindi gender agreement (regression from a live run)", () => {
  it("matches kitna / kitni / kitne, not just kitna", () => {
    // `door` and `doori` are feminine, so "kitni door hai" is the form people
    // actually type. A live run of "Balaghat se Gondia kitni door hai?" fell
    // through to the general assistant because only `kitna` was matched.
    expect(top("Balaghat se Gondia kitni door hai?")).toBe(AGENT_IDS.location);
    expect(top("Balaghat se Gondia kitna door hai?")).toBe(AGENT_IDS.location);
    expect(top("Gondia kitne door hai")).toBe(AGENT_IDS.location);
    expect(top("Gondia ki kitni doori hai")).toBe(AGENT_IDS.location);
  });

  it("still ignores 'kitna' with no distance noun after it", () => {
    // "kitna budget hai" is a Meta question, not a map one.
    expect(candidates("is campaign ka kitna budget hai")).not.toContain(AGENT_IDS.location);
  });
});
