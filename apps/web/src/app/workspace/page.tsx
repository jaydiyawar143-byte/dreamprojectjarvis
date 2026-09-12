"use client";

// ---------------------------------------------------------------------------
// Google Workspace — Gmail, Drive and Calendar, read-only.
//
// A real page in the dashboard navigation, not a demo: every panel calls a
// typed backend endpoint that the identically-named JARVIS tool also reaches,
// through one service. Nothing here holds business logic, so there is no check
// the spoken path is missing.
//
// WHY A PAGE RATHER THAN THREE DASHBOARD WIDGETS. The dashboard's
// `DEFAULT_LAYOUT` tiles its 12×12 grid EXACTLY — 144 cells, no holes — and the
// viewport tests pin that it fits without scrolling. Adding three widgets means
// re-tiling that grid, which risks the no-page-scroll invariant this repository
// has already had to fix once. These three surfaces also want width: a message
// list, a file list and a day-grouped agenda are poor fits for a 2×4 cell. So
// they get a page, built from the same glassmorphism `Panel` primitives the
// dashboard widgets use, reached from the same nav.
//
// NO PAGE-LEVEL SCROLL. The grid is viewport-height with `min-h-0`, and each
// panel scrolls its own list internally — the pairing that the chat route's
// regression taught us to apply together.
// ---------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { connectIntegration } from "@/lib/api";
import { PageContainer, PageHeader } from "@/components/dashboard/page-container";
import { GmailPanel } from "@/components/workspace/gmail-panel";
import { DrivePanel } from "@/components/workspace/drive-panel";
import { CalendarPanel } from "@/components/workspace/calendar-panel";

export default function WorkspacePage() {
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Starts consent, including the three Workspace services.
   *
   * The scope set is decided by the SERVER from the service names — this page
   * never composes a consent URL, so it cannot request more access than the
   * server intends. Read-only scopes only; `scopesForConnect` cannot emit a
   * write scope.
   */
  const connect = useCallback(async () => {
    setNotice(null);
    const result = await connectIntegration("google", ["gmail", "drive", "calendar"]);

    if (result.success && result.data?.authUrl) {
      window.location.href = result.data.authUrl;
      return;
    }
    setNotice(result.error?.message ?? "Could not start Google authorization.");
  }, []);

  return (
    // `h-full flex flex-col min-h-0` turns the container into a real height
    // chain. `<main>` is already `min-h-0 flex-1`, so this page is exactly its
    // height and each panel's list scrolls itself — rather than the panels
    // growing and handing the scroll back to `<main>`.
    <PageContainer className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Google Workspace"
        description="Read-only access to Gmail, Drive and Calendar. JARVIS can answer questions about all three; nothing here can send, modify or delete anything."
      />

      {notice && (
        <p data-testid="workspace-notice" className="text-xs leading-relaxed text-amber-300/90">
          {notice}
        </p>
      )}

      {/*
        Viewport-height grid with internal scrolling per panel.

        `min-h-0` on the grid AND on each panel is load-bearing: a flex/grid
        child defaults to `min-height: auto` and refuses to shrink below its
        content, so without it each list would grow and push the page taller
        instead of scrolling itself.

        Stacks to one column under `lg`, where three side-by-side lists would be
        unusable.
      */}
      <div
        data-testid="workspace-grid"
        className="grid min-h-0 flex-1 gap-3 lg:grid-cols-3"
      >
        <div className="flex min-h-0 flex-col">
          <GmailPanel onConnect={() => void connect()} />
        </div>
        <div className="flex min-h-0 flex-col">
          <DrivePanel onConnect={() => void connect()} />
        </div>
        <div className="flex min-h-0 flex-col">
          <CalendarPanel onConnect={() => void connect()} />
        </div>
      </div>
    </PageContainer>
  );
}
