# 0052 — Daily tasks & reports engine

**Status:** Accepted — 2026-11-02 (owner roadmap [`owner-tasks-roadmap.md`](../../owner-tasks-roadmap.md),
"مواصفات معتمدة مبدئياً للتنفيذ"). Adds the `tasks` backend module and the Flutter `tasks` feature.
Scope is exactly the roadmap's: no recurrence, no deadlines, no reminder for "acknowledged but not
completed", text reports only (roadmap §17).

## Context

The institution distributes its daily work through WhatsApp groups and follows it up by hand. The owner
asked for one engine in the app to publish a task to a staff audience, see who acknowledged and who did
not, collect and review written reports, remind the silent, report on it, and archive it — with history
kept, authorization in the backend, and no parallel messaging or group system.

What already existed and is reused, not duplicated: identity's roles and authorization (ADR 0005), the
communities as the institution's groups (ADR 0016/0039), the notifications inbox + realtime + push
pipeline (ADR 0013/0036), the audit log (platform), the in-process event bus (ADR 0006/0021), the reporting
command-center registry (ADR 0040). What did not exist: any task, assignment, report or review model —
the `automation` and `assignments` seams are empty and are **not** this engine (homework stays GROUP D).

## Decision

### 1. A new module, `tasks`; one atomic act per repository write
Like every module (ENGINEERING_RULES §9), each persistence port has a Drizzle adapter and an **in-memory
twin** with the same guarantees, chosen in the module by whether a database is configured. Ports are cut
by cohesion — tasks, assignments, reports, templates, the operation log (written inside the acts), and a
read-only query port for the dashboard/search/export. **Each write method is one act and is atomic**: it
writes its rows and the act's operation-log rows in one transaction (the house pattern of live chat's
`post`), guarded by conditional updates and unique constraints. Archiving is a separate, idempotent,
state-derived act (`archiveIfSettled`) the use cases call after a response or a review.

### 2. Audiences, resolved and snapshotted at publish
Three audiences (roadmap §2), mapped to identity roles:

| Audience | Roles |
| --- | --- |
| `TEACHERS` (المعلمات) | `TEACHER`, `ASSISTANT_TEACHER` |
| `SUPERVISORS` (المشرفات) | `SUPERVISOR` |
| `ADMINISTRATION` (الإدارة) | `ADMIN` |

A task targets one or more audiences, optionally **narrowed to one existing community** (the app's groups:
"recipients = audience ∩ that community's active members") — the groups are reused, not re-created.
Recipients are resolved **once, at publish**, through two narrow contracts — identity's new
`ACCOUNT_ROSTER` (ACTIVE holders of roles, ids only) and communities' `COMMUNITY_MEMBERSHIP.members` —
and stored as assignments. A later role change does not silently add or remove people from a published
task; the record of who was asked stays true. The publisher is not addressed to themself. OWNER and ADMIN
may address all three audiences (the owner is not an audience).

### 3. Data model (one table per concept; ids are opaque text, no cross-module foreign keys)

| Table | Holds |
| --- | --- |
| `tasks_templates` | a reusable configuration (title, body, kind, audiences, community, buttons, report, approval) — never responses |
| `tasks` | one published task: its current configuration, `revision`, lifecycle (`OPEN`/`CANCELLED`), `archived_at`, provenance (`template_id`, `republished_from`), idempotency key |
| `tasks_revisions` | every version of a task's content and configuration (revision 1 = as published) |
| `tasks_assignments` | one addressee of one task: ack/completion times, `ack_revision`, reassignment links |
| `tasks_reports` | one report per assignment: status, current version, approval stamp, soft-delete stamp |
| `tasks_report_versions` | every text version of a report, who wrote it and when |
| `tasks_report_reviews` | every review decision (approve / changes requested) with its note and version |
| `tasks_events` | the operation log (§9): actor, action, ids, time |

Uniqueness and checks in the database settle races: one task per `(created_by, client_request_id)`; one
**ACTIVE** assignment per `(task, recipient)`; one report per assignment; one version per
`(report, version)`; status vocabularies are CHECKed.

### 4. Task configuration and how a recipient completes
- `buttons` ⊆ {`ACKNOWLEDGE`, `COMPLETE`} — chosen per task, stored as a list so another button kind can
  be added later without remodelling (roadmap §3).
- `reportRequired` (text only), `approvalMode` `AUTO` | `MANUAL`, `kind` `GENERAL` | `ATTENDANCE` |
  `TEACHING` — the kind is chosen by the **publisher**, never the recipient, and decides the report
  category (§6).
- The completion method follows from the configuration (pure function `completionMethod`):
  `COMPLETE` present → the complete button (with the report when required); no `COMPLETE` but a report →
  submitting the report completes; neither → acknowledging completes. A configuration with no button and
  no report is refused.
- With `ACKNOWLEDGE` present, completion requires acknowledgement first (roadmap §3, steps 2–3).

### 5. Lifecycles (pure domain functions, each transition one use case)
- **Assignment:** `PENDING` → `ACKNOWLEDGED` → `COMPLETED`; or `REASSIGNED` (closed; a new assignment is
  created for the new addressee and linked both ways — the old one keeps its responses).
- **Report:** `PENDING_REVIEW` → `APPROVED` | `CHANGES_REQUESTED` → (edit) → `PENDING_REVIEW`; `DELETED`
  (soft — by OWNER/ADMIN; versions kept; the author may submit again). In `AUTO` mode a submitted or
  resubmitted version is approved at once (stamp: approver `null` = automatic). Editing an `APPROVED`
  report returns it to `PENDING_REVIEW` (manual mode).
- **Task:** `OPEN` → `CANCELLED`; independently `archived_at` is set automatically when every ACTIVE
  assignment is completed and every required report is `APPROVED`, and on cancellation. **Reopen** clears
  `archived_at` (and a cancellation), keeping all history.

### 6. Report categories — automatic
Category = the task's `kind`: `GENERAL` → task-completion reports, `ATTENDANCE` → attendance reports,
`TEACHING` → teachers' reports. The recipient never chooses it.

### 7. Editing a published task
OWNER/ADMIN edit; each edit is a new `tasks_revisions` row and bumps `revision` (optimistic concurrency:
the request names the revision it edits; a stale one is `409 tasks.revision_conflict`). Responses are
kept. The **content** (title, instructions, kind) can always be edited; the **settings** (buttons, report
requirement, approval mode) only while nobody has responded (`412 tasks.settings_locked`) — changing how
completion works under people who already completed would leave them in states the new settings cannot
reach (for example, completed without a now-required report). With `requireReacknowledge`, every not-yet-completed assignment returns to `PENDING`
(`ack_revision` records which version was acknowledged). Recipients are notified.

### 8. Reminders, reassignment, templates, re-publish
- **Remind non-responders** reaches only ACTIVE assignments with no response (never acknowledged nor
  completed); each reminder is logged. No reminder exists for "acknowledged but not completed" (§17).
- **Reassign** an open assignment to another ACTIVE holder of a role in the task's audiences.
- **Templates** and **re-publish** are OWNER-only (`tasks.template`, roadmap §10); each re-publish or
  template use creates a fully independent task (new id, new assignments, new reports).

### 9. Operation log and audit
Every management act (create, edit, cancel, reopen, reassign, remind, report edit/delete, review) is one
`tasks_events` row (actor, action, ids, time) **and** an audit-log entry. Report bodies never enter the
log, the audit, an event payload or a log line — ids only.

### 10. Authorization (backend-enforced, twice)
Permissions `tasks.manage` (OWNER, ADMIN), `tasks.template` (OWNER), `tasks.respond` (TEACHER,
ASSISTANT_TEACHER, SUPERVISOR; OWNER/ADMIN by the provisional filters). Route guards are the outer edge;
every use case re-asks identity, and recipient routes additionally prove that the assignment is the
caller's own (a guessed id is `404`, never a leak). All administration members are equal: no creator-only
rule (roadmap §7).

### 11. Notifications
A new `TASKS` category, target kind `task` (opens the task), eleven types, translated from the module's
events by one translator in `notifications`: published/updated/cancelled/reminder/reassigned → the
addressees concerned; acknowledged/completed/report-submitted/resubmitted → the publisher, **grouped** to
one notification per task, type and hour (dedupe bucket); changes-requested/approved → the report's author.
In-app + realtime work today. **Push** rides the existing pipeline but no FCM/APNs provider is configured
(`LoggingPushProvider`, Q24) — it delivers nothing until the owner supplies credentials (external).

### 12. Dashboard, search and export
Aggregates are computed in SQL over the filtered set (period, audience, community, person, kind, task and
report status): acknowledgement and completion rates, completed/open tasks, approved / changes-requested
reports, per-audience and per-community comparison, per-person detail. **No ranking** (roadmap §12).
Search is a literal, escaped, case-insensitive match on title/body plus the same filters. Export reflects
the chosen filters: **CSV** (UTF-8 with BOM, opens in Excel) and a **print-ready RTL HTML** report the
browser saves as PDF. A native `.xlsx`/`.pdf` generator was not added: it would need new dependencies and
Arabic-shaping fonts for PDF — recorded below as an open decision.

## Consequences
- New tables (migration 0034) and permissions (migration 0035); no existing table changes.
- The architecture index, the route→permission map and the module boundaries grow by one module.
- Workflow, authorization and API tests run against an isolated Postgres only.

## Open decisions (not assumed)
1. **Section filter / section comparison** (roadmap §12): staff have no defined section (supervisors and
   administration have none; a teacher may teach in several). Needs the owner's definition.
2. **Self-review:** may an administration member approve their own report? Not forbidden by the roadmap;
   allowed today; one rule to change if the owner forbids it.
3. **Push provider** (FCM/APNs credentials) — external.
4. **Native Excel/PDF files** instead of CSV / printable HTML — needs new dependencies.
