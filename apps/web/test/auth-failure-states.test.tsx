// ---------------------------------------------------------------------------
// The login screen's two failure modes.
//
// WHY THIS FILE EXISTS. With the API server stopped, the login screen rendered:
//
//     Access Denied
//     Network request failed
//     Check Operator ID and Access Key
//
// Every line of that is wrong except the middle one. The credentials were never
// submitted anywhere — `fetch` threw before a request left the browser — so
// there was no access decision to deny, and "check your password" sends the
// operator to re-type something that was never the fault. It cost real
// debugging time on a live run.
//
// So the distinction is now load-bearing and pinned here:
//
//   AUTHENTICATION_REQUIRED  -> Access Denied     -> check your credentials
//   NETWORK_ERROR / ABORTED  -> Connection Failed -> check the server is running
//
// The branch is on the error CODE, never on the message text: branching on
// prose means a copy edit silently breaks a state.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import {
  AuthStatus,
  isTransportFailure,
  type StageKey,
  type StageState,
} from "../src/components/auth/auth-status";

/** All four checks failed — what the hook produces on any error. */
const FAILED_STAGES: Record<StageKey, StageState> = {
  identity: "failed",
  credential: "failed",
  security: "failed",
  system: "failed",
};

function renderDenied(error: string, errorCode?: string) {
  return render(
    <AuthStatus phase="denied" stages={FAILED_STAGES} error={error} errorCode={errorCode} />
  );
}

// ---------------------------------------------------------------------------

describe("isTransportFailure", () => {
  it("treats the client-side codes as transport failures", () => {
    // Both are produced by lib/api.ts when no response ever arrived.
    expect(isTransportFailure("NETWORK_ERROR")).toBe(true);
    expect(isTransportFailure("ABORTED")).toBe(true);
  });

  it("does not treat a real server rejection as one", () => {
    expect(isTransportFailure("AUTHENTICATION_REQUIRED")).toBe(false);
    expect(isTransportFailure("VALIDATION_ERROR")).toBe(false);
    expect(isTransportFailure("RATE_LIMITED")).toBe(false);
  });

  it("treats an absent code as a server rejection, not an outage", () => {
    // A missing code is the conservative case: the server answered and the
    // envelope simply carried no code. Guessing "outage" would hide a genuine
    // credential problem behind a "check the server" message.
    expect(isTransportFailure(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("a rejected credential", () => {
  it("says Access Denied and points at the credentials", () => {
    renderDenied("Invalid email or password", "AUTHENTICATION_REQUIRED");

    const panel = screen.getByTestId("auth-denied");
    expect(within(panel).getByText("Access Denied")).toBeInTheDocument();
    expect(within(panel).getByText(/Check Operator ID and Access Key/i)).toBeInTheDocument();
  });

  it("shows the server's own message verbatim", () => {
    // Never replaced by flavour text: the server said why, and that is the
    // most useful sentence on the screen.
    renderDenied("Invalid email or password", "AUTHENTICATION_REQUIRED");
    expect(screen.getByText("Invalid email or password")).toBeInTheDocument();
  });

  it("falls back to Access Denied when no code was supplied", () => {
    renderDenied("Invalid email or password");
    expect(screen.getByTestId("auth-denied")).toBeInTheDocument();
    expect(screen.queryByTestId("auth-unreachable")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("an unreachable server", () => {
  it("says Connection Failed, NOT Access Denied", () => {
    renderDenied("Network request failed", "NETWORK_ERROR");

    const panel = screen.getByTestId("auth-unreachable");
    expect(within(panel).getByText("Connection Failed")).toBeInTheDocument();
    // The exact regression: an outage must not read as an access decision.
    expect(screen.queryByText("Access Denied")).toBeNull();
  });

  it("points at the SERVER, not at the operator's credentials", () => {
    renderDenied("Network request failed", "NETWORK_ERROR");

    expect(screen.getByText(/Check that the API server is running/i)).toBeInTheDocument();
    // This is the line that sent someone to re-type a working password.
    expect(screen.queryByText(/Check Operator ID and Access Key/i)).toBeNull();
  });

  it("says plainly that the credentials were never submitted", () => {
    // Worth stating outright: someone whose password did reach a server has a
    // different problem from someone whose request never left the browser.
    renderDenied("Network request failed", "NETWORK_ERROR");
    expect(screen.getByText(/credentials were not submitted/i)).toBeInTheDocument();
  });

  it("treats a cancelled request the same way", () => {
    renderDenied("Request was cancelled", "ABORTED");
    expect(screen.getByTestId("auth-unreachable")).toBeInTheDocument();
  });

  it("does not render the raw client-side string as though a server said it", () => {
    // "Network request failed" is generated in lib/api.ts, not by the API. It
    // is replaced with something that explains the situation.
    renderDenied("Network request failed", "NETWORK_ERROR");
    expect(screen.queryByText("Network request failed")).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("the overlay's other phases are untouched", () => {
  it("renders nothing while idle", () => {
    const { container } = render(
      <AuthStatus phase="idle" stages={FAILED_STAGES} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("still announces success as Access Granted", () => {
    render(
      <AuthStatus
        phase="granted"
        stages={{ identity: "ok", credential: "ok", security: "ok", system: "ok" }}
      />
    );
    expect(screen.getByText("Access Granted")).toBeInTheDocument();
  });

  it("announces the failure assertively for screen readers", () => {
    renderDenied("Network request failed", "NETWORK_ERROR");
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "assertive");
  });
});
