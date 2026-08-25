# Documentation Protocol

## Purpose

This document establishes the protocol for maintaining JARVIS documentation. Every future phase must update documentation alongside code changes.

## Documentation Structure

```
docs/
├── JARVIS_USER_MANUAL.md          Main user-facing manual
├── JARVIS_ARCHITECTURE.md         Technical architecture
├── JARVIS_CAPABILITY_MATRIX.md    Implemented/Verified/User-Accessible matrix
├── DOCUMENTATION_PROTOCOL.md      This file
├── DOCUMENTATION_AUDIT.md         Audit report
├── ARCHITECTURE.md                Legacy architecture (pre-existing)
├── CONTRACTS.md                   Runtime contracts (pre-existing)
├── phases/
│   ├── phase-9.md                 Phase 9 documentation
│   ├── phase-10.md                Phase 10 documentation
│   └── phase-11.md                Phase 11 documentation
└── diagrams/
    ├── system-architecture.mmd    System architecture diagram
    ├── data-flow.mmd              Intelligence pipeline flow
    ├── execution-flow.mmd         Execution sequence diagram
    ├── optimization-loop.mmd      Optimization feedback loop
    └── phase-evolution.mmd        Phase timeline diagram
```

## Future Phase Documentation Requirements

Before declaring any future phase complete:

### Mandatory Updates

1. **Update main user manual** if any user-facing capability changed.
2. **Update phase history** — add or update the relevant phase document under `docs/phases/`.
3. **Update capability matrix** — add or modify capability entries with correct IMPLEMENTED/VERIFIED/USER-ACCESSIBLE status.
4. **Update architecture diagrams** if architecture changed (add new components, modify data flow).
5. **Add before/after example** — show what changed from the user's perspective.
6. **Record changed files** — list all files added, modified, or deleted.
7. **Record test evidence** — include test counts and verification status.
8. **Record limitations** — document honest limitations of the new phase.
9. **Record exact verdict** — PASS, PARTIAL, or BLOCKED with supporting evidence.
10. **Distinguish implemented / verified / user-accessible** — never conflate these three statuses.

### Documentation Quality Rules

- **Readable:** Written for both developers and non-developers.
- **Structured:** Consistent heading hierarchy and formatting.
- **Honest:** No unsupported claims. No marketing hype.
- **Chronological:** Phase history preserves the actual timeline.
- **Technically accurate:** Claims verified against source code and tests.
- **Example-driven:** Every capability section includes a practical example.
- **Conservative on accessibility:** If uncertain whether something is user-accessible, mark it as not user-accessible.

### What NOT to Do

- Never modify application code in a documentation-only phase.
- Never rewrite historical phases to make them look better.
- Never claim "autonomous" when human approval is still required.
- Never present synthetic/example data as real production data.
- Never fabricate test counts or verification results.
- Never document capabilities that don't exist in the current codebase.
- Never add dependencies or tooling just for documentation generation.

### Append Corrections Transparently

If a previous phase's documentation contains errors:

```markdown
### Correction (added YYYY-MM-DD)

Previous documentation stated [X]. This was incorrect.
The accurate information is [Y].
Evidence: [file:line reference]
```

Never delete or silently modify historical documentation.

### Diagram Maintenance

- Use Mermaid syntax for all diagrams (not screenshots).
- Diagrams must be editable and version-controlled.
- When architecture changes, update the corresponding diagram.
- Create new diagrams only when the existing ones cannot represent the change.

### Secret Scanning

Before committing documentation:

1. No API keys (sk-, EAA-, Bearer, JWT).
2. No database connection strings.
3. No password hashes.
4. No internal hostnames or IP addresses.
5. No real Meta access tokens.
6. No real user data.

Use pattern matching against:
- `sk-proj-`, `sk-ant-`, `sk-org-` (OpenAI)
- `EAA` (Meta access tokens)
- `Bearer ` (authorization headers)
- `postgresql://` (database URLs)
- `JWT_SECRET`, `DATABASE_URL`, `OPENAI_API_KEY` (env var values)

---

*Document version: 1.0*
*Last updated: 2026-08-25*
