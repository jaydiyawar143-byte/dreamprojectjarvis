# NOTICE — the n8n node-schema snapshot

This directory holds a **reduced, modified copy** of parts of the npm package
`n8n-nodes-base`, and nothing else.

| | |
|---|---|
| Upstream project | n8n — https://github.com/n8n-io/n8n |
| Package | `n8n-nodes-base@2.15.1` |
| Tarball | https://registry.npmjs.org/n8n-nodes-base/-/n8n-nodes-base-2.15.1.tgz |
| Registry SHA-512 | `sha512-E4/vb8sBb4tzZSFoBAP2EigAHSc3uEn52RdfyTu1C7xPBNLYDfw5y5OxvMmHBQ8of9YQwcK9AQsoEsggyu7ztQ==` |
| SHA-256 | `43e200c1cbe1c4a9f967efa079facb00cc3cbe51ede23c9a3cfc66c9a4051406` |
| Size of the verified tarball | 9171770 bytes |
| Provenance | https://registry.npmjs.org/-/npm/v1/attestations/n8n-nodes-base@2.15.1 |
| Provenance detail | SLSA provenance v1, built by n8n-io/n8n's own release workflow through GitHub OIDC; the attestation's subject digest is the SHA-512 above |
| Licence | Sustainable Use License v1.0 — the full text is in ./node-schema-LICENSE.md, copied verbatim from the verified package's own `LICENSE.md` |

## What this is

`node-schema.ts` keeps, for each of the 28 node types a JARVIS draft may hold:

- the node type and its label;
- the versions the node declares, and the one the snapshot describes;
- for each parameter: its name, its type, whether the upstream schema requires
  it, whether the upstream schema shows it only in some configurations, the
  literal option values where the upstream schema lists them, and the numeric
  bounds where it declares them.

Everything else in the upstream package — the node code, the credentials, the
icons, the documentation, the other node types, the parameter types' internals
— is not here. A parameter whose options are loaded dynamically is left without
an option list on purpose: JARVIS then does not claim a value was one of the
options.

## This file is modified

It is a derivative work of the licensed work, reduced to the fields JARVIS
checks a draft against. The upstream notices are not altered, removed or
obscured; they are reproduced above and in the licence copy beside it, and
this file says so where it is read.

## Node types that could not be reduced

- None: every node type in the list above was read and reduced.

## What you may do with it

The Sustainable Use License v1.0 permits use, copying, modification and distribution for
your own internal business purposes, or for non-commercial or personal use,
provided the notices are kept and any modification is marked — as they are,
here. Distribution to others must be free of charge and non-commercial.

JARVIS uses the snapshot only to check a draft's settings offline. It never
redistributes n8n itself, never sends the snapshot to an n8n instance, and
never asks an n8n instance for its schemas.

If you do not accept these terms, do not use or redistribute this directory.
