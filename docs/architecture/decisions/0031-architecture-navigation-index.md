# 0031 — A generated, code-derived architecture index and a root entry point

**Status:** Accepted
**Date:** 2026-10-10

## Context

The repository documents its architecture thoroughly — `overview.md`,
`module-boundaries.md`, `dependency-rules.md`, the per-module docs, and thirty
ADRs — and enforces its backend boundaries executably (ADR
[0009](0009-executable-architecture-rules.md): dependency-cruiser plus the
`test/architecture/*` specs, in CI). Two gaps remained for navigation, both
confirmed by audit against the tree:

1. **Nothing an agent or a newcomer loads first points at any of it.** There was
   no root `CLAUDE.md`/`AGENTS.md`, so the mandatory reading order
   (`ENGINEERING_RULES.md`, then `project-checkpoint.md`) and the doc map had to
   be known in advance rather than discovered. The facts needed to answer "where
   does X live, what may it depend on, and why" are spread across five documents,
   thirty ADRs, ~397 backend source files and ~182 Dart files.
2. **The hand-maintained cross-references drift.** At the time of this decision
   `module-boundaries.md` stated "the attendance module does not exist" while
   `backend/src/modules/attendance/` was a fully implemented module, and the ADR
   index in `decisions/README.md` stopped at 0025 while 0026–0030 existed. Drift
   in a manually maintained index is not an accident to fix once; it is the
   steady state of prose that restates code.

The same insight that made ADR 0009 work applies: a boundary — or an index — that
is only prose erodes; one the build regenerates and checks does not.

## Decision

Add a navigation layer built from the code, not alongside it.

1. **A root `CLAUDE.md`** — a short pointer to the governance, the checkpoint,
   the overview, the index and the enforced boundaries. It restates none of them.

2. **A generated architecture index**, `docs/architecture/architecture-index.md`,
   produced by `backend/test/tooling/architecture-index.ts`:
   - Backend, per module: path, Nest `exports:` surface, the public `contracts/`
     surface, the domain events declared in `contracts/events.ts`, and the other
     modules it statically imports — the backend graph read through the same
     dependency-cruiser cruise the boundary spec uses.
   - Flutter, per feature: path, controllers, and the lib areas and sibling
     features it statically imports — scanned with the exact import regex the
     app's own boundary tests use — plus the repository contracts, routes and
     entry points.
   - Only mechanical facts. Responsibility and "what it must not know" stay in
     `module-boundaries.md`; the index links to it.
   - **Every edge is a static import, never a runtime call.** Cross-module
     collaboration is mostly events over the in-process bus, so runtime
     relationships are taken only from declared events in `contracts/`, never
     inferred from the import graph.
   - Reproducible: `npm run arch:index` writes it; `npm run arch:index:check`
     fails on drift. Freshness is enforced in CI by
     `test/architecture/architecture-index.spec.ts`, which regenerates in memory
     and asserts the committed bytes match — inside `npm test`, and so inside
     `npm run verify`. The spec carries floors on what was discovered and a check
     that its comparison can fail, so it cannot pass vacuously.

3. **A project-wide Flutter layering test**, `app/test/architecture/layering_test.dart`,
   asserting the layer directions that hold across the whole app — data never
   imports features; core never imports features and reaches data only for wire
   models; concrete repository impls are reached only from the composition root;
   the repository contracts stay pure — each with a synthetic negative control.
   It complements, and does not duplicate, the per-feature SDK/adapter boundary
   tests. It asserts only directions the code already satisfies: deliberate
   cross-feature UI edges mean no blanket feature-to-feature ban is stated.

No new dependency, service, graph platform, database or code generator is
introduced. The generator reuses dependency-cruiser and ts-node; the Dart test
uses `dart:io` and `flutter_test`. CI needs no new workflow step: the two gates
already run the specs.

## Consequences

**Good.**
- A task starts at one generated map instead of re-deriving structure by grep.
- The index cannot silently drift: a module, feature or ADR added without
  regenerating turns the build red, the same way an illegal import does.
- The drift that motivated this (attendance missing, the ADR index short) is
  reconciled in the same change, from the current tree and the accepted ADRs.

**Bad, and accepted.**
- The index is a generated artifact in the tree; a change that touches module
  structure must run `npm run arch:index` before committing. The check makes the
  omission loud rather than silent.
- The generator reads `app/lib` and `docs/` from the backend workspace, so the
  backend test suite now also fails when the committed index is stale — a small
  coupling, accepted because the index is a repository-level artifact and the
  backend gate is the one already run everywhere.
- Mechanical extraction states names and edges, not meaning. Intent stays in the
  authored docs, which the index links to rather than copying — on purpose, so a
  second drifting prose surface is not created.

## Alternatives considered

**A hand-written index document.** Rejected: it is exactly what already drifted.
A document that restates the code is only ever as current as its last manual edit.

**A dependency-graph/visualisation platform, or adding madge, nx or ts-morph.**
Rejected, consistent with ADR 0009: dependency-cruiser already produces the graph
the index needs, and a whole new tool (or platform) to render it is cost without
a matching need. The goal is navigation, not a graph product.

**A `custom_lint`/analyzer-plugin layering rule for Dart.** Rejected: the app
deliberately avoids plugin linters and codegen, and the analyzer does not enforce
import direction natively. The established in-repo idiom is import-scan assertions
as `flutter_test` tests; this follows it.

**Inferring runtime module relationships from the import graph.** Rejected as
unsound: the modules talk through events, which the import graph does not show.
The index labels its edges as static imports and takes events from `contracts/`.
