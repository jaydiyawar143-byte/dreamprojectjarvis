// ---------------------------------------------------------------------------
// Phase 15 — Google Ads as a report source: is it readable, and if not, why.
//
// THE RULE THIS IMPLEMENTS. Google Ads may be used only once the access it
// needs has actually been GRANTED and that grant has been verified. So before
// a report says anything about Google Ads, this asks the one component that
// already knows — the capability service, which derives each capability from
// the registered tools, the user's own connection, and the scopes Google
// really returned (never the ones that were requested).
//
// IT ADDS NO SECOND OPINION. There is no scope check written here. If the
// capability layer says the Ads read needs a permission that was not granted,
// that is what the report records, in that layer's own words.
//
// AND IT NEVER SAYS "INCLUDED". Phase 15 puts no Google Ads figure in a
// report: there is no grant carrying the Ads scope to verify such a read
// against. When every gate IS open, the answer is NOT_INCLUDED — usable, and
// deliberately not used yet — so a report states that plainly instead of
// leaving Google Ads out without a word.
// ---------------------------------------------------------------------------

import type { CapabilityReport, ReportSourceStatus } from "@jarvis/core";

/** The capability whose state stands for "can Google Ads performance be read". */
const GOOGLE_ADS_READ_CAPABILITY = "google.insights";

export interface GoogleAdsSourceAnswer {
  status: ReportSourceStatus;
  detail: string;
}

const NOT_SET_UP: GoogleAdsSourceAnswer = {
  status: "NOT_CONFIGURED",
  detail:
    "Google Ads is not set up on this server. It needs a Google connection with Google Ads access approved, and a Google Ads developer token.",
};

export async function googleAdsReportSource(
  capabilities: { report(userId: string): Promise<CapabilityReport> } | null,
  userId: string
): Promise<GoogleAdsSourceAnswer> {
  // No capability service means no integration state can be read at all.
  if (!capabilities) return NOT_SET_UP;

  const report = await capabilities.report(userId);
  const read = report.capabilities.find((capability) => capability.id === GOOGLE_ADS_READ_CAPABILITY && capability.registered);

  // The Ads read tools are not registered on this deployment, so nothing
  // could read Google Ads whatever a user had connected.
  if (!read) return NOT_SET_UP;

  switch (read.availability) {
    case "EXECUTABLE":
      return {
        status: "NOT_INCLUDED",
        detail:
          "Google Ads is connected with Ads access granted, but this version of JARVIS does not put Google Ads figures in reports yet.",
      };
    case "PERMISSION_MISSING":
      return {
        status: "SCOPE_NOT_GRANTED",
        detail: [read.reason, read.requiredAction].filter((part): part is string => Boolean(part)).join(" ") ||
          "Your Google account is connected, but access to Google Ads was not granted.",
      };
    case "NOT_CONNECTED":
    case "NEEDS_REAUTH":
    case "DISABLED":
      return {
        status: "NOT_CONNECTED",
        detail: [read.reason, read.requiredAction].filter((part): part is string => Boolean(part)).join(" ") ||
          "No Google account is connected.",
      };
    default:
      return { status: "NOT_CONFIGURED", detail: read.reason ?? NOT_SET_UP.detail };
  }
}
