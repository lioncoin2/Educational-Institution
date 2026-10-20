# 0042 — Operations: scheduling of individual dated lessons

**Status:** Accepted — 2026-10-20 (owner decision; approved product decisions D1–D5 in
[`scheduling-decision-brief.md`](../../scheduling-decision-brief.md), which this ADR implements). Builds
the first behaviour of the `operations` module, previously a boundary-only seam. It confirms, does not
change, the attendance separation of [ADR 0020](0020-attendance-snapshots.md)/[0023](0023-attendance-authorization-and-policy.md).

## Context

The owner directed building a real, extensible scheduling capability for **individual dated lessons**,
having confirmed the shape in register §24 and approved the open decisions (who may schedule; how a lesson
is stored; IANA/DST handling; validation/conflict boundaries) as D1–D5. Scheduling had only a
contracts-only seam (`operations`), and the institution timezone existed only inside the owner-**rejected**
quiet-hours resource — so a conflict had to be resolved (below). No recurrence, attendance derivation,
assignments, notifications or automatic live sessions are in scope (register §24, §8 exclusions).

## Decision

- **One-off dated lessons only; no recurrence** (register §24). A lesson belongs to exactly one halaqa.
- **A lesson stores its wall clock AND its instant.** The local date (`YYYY-MM-DD`), local time (`HH:MM`)
  and the **IANA timezone captured at creation** are persisted alongside the resolved `scheduled_at`
  `timestamptz`. Capturing the zone per lesson means a later change to the institution timezone never
  silently moves an existing lesson (D2/D3).
- **DST is resolved explicitly, not guessed.** A dedicated, pure resolver (`domain/time-resolution.ts`)
  converts the wall clock to an instant via the platform `Intl` tz database: a spring-forward **gap**
  (a local time that never occurs) is **rejected**; a fall-back **fold** (a local time that occurs twice)
  resolves deterministically to the **earlier** instant (D3/D5). IANA names only — a fixed offset is
  refused.
- **Future-only.** A new or rescheduled lesson's instant must be **strictly after** the injected
  `Clock`'s now; past-dating is rejected (D4/D6). No conflict policy is implemented — overlap is allowed —
  because "what is a conflict" is a separate owner decision (D4); the policy seam
  (`domain/scheduling-policy.ts`) is where a horizon or conflict rule would later live.
- **Authorization: one new capability, owner/admin only.** Every route (read and write) requires
  **`operations.schedule_manage`**, held by OWNER (all permissions) and ADMIN (the all-minus-settings/
  messaging filter) and **no other role**. Each use case re-authorizes through the identity port; reads
  are gated too, so a guessed lesson id reveals nothing to a non-manager. The owner named the capability
  `operations.schedule.manage`; the stored code is `operations.schedule_manage` because the immutable
  `permissions_code_shape` CHECK (migration 0001) allows a single `namespace.action` dot — same meaning.
- **Halaqa existence is validated across the boundary** through academic's public
  `ACADEMIC_RELATIONSHIPS.halaqaExists` (existence only), never a foreign key or a reach into academic's
  tables (the same boundary-legal pattern as the Q50 community↔halaqa link).
- **Cancellation is an auditable state transition, never a delete.** A lesson is `SCHEDULED` or
  `CANCELLED`; cancelling records `cancelled_at`/`cancelled_by` and keeps the row. A cancelled lesson is
  terminal (no reschedule, no re-cancel).
- **Idempotent create.** An optional `clientRequestId` makes a retried create return the existing lesson
  (one per creator+key, a partial unique index), so a network retry cannot duplicate.

### Conflict resolved (reported, not silently worked around)

Decision 2 wants the **institution timezone** as the default for new lessons, but the only institution
timezone in the system lives in the **quiet-hours** settings resource, which the owner **rejected** for any
new use (roadmap §4/§8, register §25) and whose `PUT` even requires a quiet-hours *window*. Reading it
would violate that rejection. **Resolution:** a new, neutral `institution.timezone` deployment setting
(`INSTITUTION_TIMEZONE`, IANA-validated in platform config, wired into compose) is the default source,
**decoupled from quiet hours**; when it is unset the API requires the client to name a zone
(`operations.timezone_required`). Unifying the two institution-timezone notions is a future owner decision.

## Mechanics (implemented)

- **Module** `operations`: `domain/` (lesson entity + lifecycle, the DST resolver, the scheduling policy,
  ports), `application/` (5 use cases, access, cursors, views), `api/` (controller + DTOs + responses),
  `infrastructure/` (Drizzle + in-memory repositories + `operations_lessons` schema). Exports nothing (no
  other module consumes scheduling yet).
- **Routes** (`/operations`): `POST /lessons` (201, or 200 on an idempotent replay), `GET /lessons`
  (keyset-paged, ordered by instant), `GET /lessons/:id`, `PATCH /lessons/:id` (reschedule), `POST
  /lessons/:id/cancel`. HTTP mapping as usual: validation→422, not_found→404, forbidden→403,
  precondition_failed→412.
- **Migrations** `0026_operations_lessons` (DDL: the table, CHECKs for status / local-date & -time shape /
  cancelled-consistency / updated≥created, two btree indexes, a partial-unique idempotency index) and
  `0027_seed_operations_schedule_permission` (data: the permission + OWNER/ADMIN grants). Additive;
  pre-existing data untouched.
- **Flutter** `features/scheduling`: a permission-gated list (`operations.schedule_manage`), a create/edit
  sheet (program→halaqa cascade from the academic catalogue, native date/time pickers, an IANA-zone
  dropdown, duplicate-submit guard, Arabic error toasts), a detail with cancel confirmation. New
  `SchedulingRepository` (http + demo mock), model `ScheduledLesson`.

## How this is verified (in source)

- Domain: `time-resolution.spec.ts` (unique / summer / gap-reject / fold→earlier, for New York & London &
  Riyadh; invalid zone & date), `scheduling-policy.spec.ts` (strict future), `lesson.spec.ts`.
- Application: `lesson.use-cases.spec.ts` (authz, unknown halaqa, timezone default & required, DST, past,
  idempotency, invalid lifecycle transitions, institution-tz-change, no implicit attendance/notification).
- API/integration: `test/api/operations.api.spec.ts` (HTTP e2e incl. 401/403, round-trip, 404, DST 422,
  past 422, malformed 400, reschedule/cancel/412, idempotent 200, guessed-id 403);
  `test/integration/operations-postgres.spec.ts` (schema by name, CHECK rejections, persistence
  round-trips, keyset paging, seed grants, migration delta) on real Postgres.
- Flutter: model, http + mock repositories, and screen (gated entry, list states, cancel confirmation,
  Arabic error rendering, form submit-gating).

## Consequences

- The `operations` module is now live with one capability; adding a horizon, a conflict policy, or teacher
  authorship is a localized change in the policy seam or the permission grant — not a rewrite.
- A new per-deployment `INSTITUTION_TIMEZONE` config exists, separate from the quiet-hours timezone.

## Alternatives considered

- **Read the institution timezone from the quiet-hours resource.** Rejected — the owner rejected that
  resource for any new use; a neutral config is explicit and decoupled.
- **Store a UTC instant only.** Rejected — a later DST-rule change would drift the wall clock (Q12).
- **Represent cancellation as a delete.** Rejected — the plan's history must be preserved (auditable).
- **A conflict rule in v1.** Deferred — "conflict" is an institutional definition the owner must give (D4).
