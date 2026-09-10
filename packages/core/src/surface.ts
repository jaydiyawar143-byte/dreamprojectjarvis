// ---------------------------------------------------------------------------
// The browser-safe surface entry point.
//
// Imported by the web app as `@jarvis/core/surface`, NEVER as `@jarvis/core`.
//
// WHY THIS FILE EXISTS.
//
// The package barrel reaches the outcome engine, which imports `node:crypto`.
// Webpack cannot resolve a `node:` scheme for the browser, so a single
// `import { Surface } from "@jarvis/core"` in a client component takes the
// whole web build down with `UnhandledSchemeError` — including the login page,
// which has nothing to do with surfaces.
//
// Everything re-exported here is pure data and pure functions: a Zod schema, a
// static registry and a set of regular expressions. No Node built-ins, no
// filesystem, no crypto, no environment.
//
// The decision engine is deliberately NOT here. It is server-side by design —
// it reads tool results and it is the thing the client must not be able to
// influence — and exporting it to the browser would blur exactly the boundary
// the surface model exists to draw.
//
// (`./voice` is the same pattern, for the same reason.)
// ---------------------------------------------------------------------------

export * from "./types/surface.js";
export * from "./surface-registry.js";
export * from "./surface-intent.js";
