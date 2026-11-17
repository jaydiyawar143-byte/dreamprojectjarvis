// ---------------------------------------------------------------------------
// VO-2.2 — `/office` is no longer a page.
//
// The Virtual Office is a widget on the dashboard and opens there as a
// full-screen dialog. This route stays only so that existing links and
// bookmarks keep working: it sends them to the dashboard with the office open.
//
// A server redirect, so nothing renders here first. The target is written out
// rather than imported from the widget: that module is a client module, and a
// server component importing a value from one receives a client reference,
// not the string. `office-widget-vo22.test.tsx` pins that the two agree. (It
// is not exported: a page file may export only Next.js's own page fields.)
// ---------------------------------------------------------------------------

import { redirect } from "next/navigation";

const OFFICE_REDIRECT_TARGET = "/dashboard?office=open";

export default function OfficeRedirect(): never {
  redirect(OFFICE_REDIRECT_TARGET);
}
