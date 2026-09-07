// UI V2 — a 404 that looks like the rest of the app rather than Next's default.
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-sys-void px-6">
      <div className="text-center">
        <p className="font-mono text-[0.62rem] uppercase tracking-hud text-sys-dim">Error 404</p>
        <h1 className="mt-3 text-2xl font-semibold text-white">This page does not exist</h1>
        <p className="mt-2 text-sm text-sys-dim">
          The address may have changed, or the link that brought you here is out of date.
        </p>
        <Link
          href="/dashboard"
          className="sys-focus mt-6 inline-block rounded border border-sys-cyan/40 bg-sys-cyan/10 px-4 py-2 font-mono text-[0.65rem] uppercase tracking-hud text-sys-cyan"
        >
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
