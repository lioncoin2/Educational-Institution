# 0040 — Owner Command Center: a reporting widget registry over existing facts

**Status:** Accepted — 2026-10-20 (owner decision, register §29: included in the first web-first Trial
release). Proposed 2026-10-19 (Owner Command Center v1, owner-directed). Activates the `reporting`
module (previously a boundary seam, register §G) as the registry its contract already describes
(`reporting/contracts/index.ts`: `WidgetDescriptor` / `WidgetProvider` / `WIDGET_PROVIDERS`). Depends on
no immutable ADR being changed; adds one read-only method to academic's public contract. Leaves every
owner-policy gate (GROUP C/D/G) untouched — it invents **no** metric, threshold, or educational rule.

**Acceptance is the owner's.** The owner directed building the real Owner Command Center on *existing,
already-authorized* data, explicitly forbidding invented KPIs/attendance rules/emergency states and
requiring that absent data be shown as absent. This record is the author's design for that direction; the
code is implemented in the working tree but **uncommitted and unmerged** while Proposed.

## Context

`reporting` was a deliberate empty seam: its contract models a dashboard as a **registry** — "a module
contributes a widget by registering a descriptor and a resolver… adding one later is one more widget,
never editing a dashboard component." The register (§G) held it *dependency-blocked* until at least one
module had an owner-approved widget, because the dashboard had nothing truthful to show and the brief
forbids inventing figures (present/absent is Q70; KPIs are undefined).

Two things made a first, honest version buildable now without inventing policy: (1) the owner authorized
surfacing **facts that already exist and are already authorized** (counts/summaries), and (2) the data
for two such facts is reachable through existing public contracts — communities via
`COMMUNITY_MEMBERSHIP.listHeads`, and the academic structure via the existing `catalogue()` read.

## Decision

1. **A server-resolved registry.** `GET /reporting/command-center` (edge `reports.read`) returns the
   widgets the viewer may see, each already resolved to its current facts. A `GetCommandCenterUseCase`
   re-checks `reports.read`, then — per the contract — **hides any widget whose `requiredPermission` the
   viewer does not hold** (the UI is never the boundary). Zero registered widgets → an empty set, never an
   error. No route writes; reporting stores no table.

2. **Providers bound inside `ReportingModule`.** Each `WidgetProvider` is constructed in reporting and
   bound into `WIDGET_PROVIDERS` by a factory (there is no `multi:true` precedent in the codebase, and a
   contributing module exporting reporting's token would violate the "a module exports only its own
   contracts' tokens" boundary test). Reporting reads other modules only through their public `contracts/`
   (dependency-cruiser `no-cross-module-internals`), acyclically.

3. **v1 widgets — facts only.** `communities.summary` (`communities.read`): total communities and those
   accepting members, counted by keyset-paging `listHeads`. `academic.structure` (`academic.read`): ACTIVE
   sections, programs and halaqat, via a new read-only `ACADEMIC_STRUCTURE_SUMMARY` contract that reuses
   `catalogue()` (no new query, **no migration**). Both are counts of existing authorized data — no
   invented metric, no policy. A widget the server cannot resolve a figure for shows "no data", never a
   fabricated zero.

4. **Gate = the existing `reports.read`.** No new permission, no migration. `reports.read` is held by
   OWNER/ADMIN/SUPERVISOR (seed 0002); per-widget `requiredPermission` narrows visibility further,
   server-side.

5. **Extensible by design.** Accounts, live and attendance widgets are deliberately **not** built: those
   modules expose no count/enumeration at their boundary, and (attendance) a present/absent figure is Q70,
   owner-gated. Each becomes one more provider when its owning module exposes a read and (where relevant)
   the owner states the rule — never by editing the resolver or the screen.

## Consequences

- A real, extensible command center ships on real data, with loading/empty/error/retry in Flutter and no
  invented figures. The academic structure gains one additive public read; communities/identity/live/
  attendance are unchanged.
- `reporting` now has `contracts/`-edges to `communities` and `academic`; the architecture index was
  regenerated. The route is registered in the authorization route-declaration guard.
- The owner-policy gates (GROUP C/D/G) are untouched: this ADR adds reporting *infrastructure* and two
  *factual* widgets, and resolves none of Q70/Q71 or the educational core.

## Alternatives considered

- **Invent KPIs / an attendance present-rate now** — rejected: forbidden (assertions about real children;
  Q70 owner-gated).
- **Build only the empty registry** — rejected as hollow; the owner asked for a real foundation, and two
  truthful widgets exist today.
- **Each module registers its own widget (`multi:true`, exported token)** — rejected: no precedent, and it
  breaks the module-exports-only-own-contracts boundary test. Reporting owns the registry instead.
