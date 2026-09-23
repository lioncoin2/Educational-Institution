# Persistence

PostgreSQL is the system of record. Redis is for things that may be lost.

The instruction that bounded this:

> Do not create a huge schema just because future features might exist. Only
> establish the minimum foundation required for the architecture.

So there are exactly the tables implemented modules need, and nothing for
modules that have no code yet:

- identity and audit: `roles`, `permissions`, `role_permissions`, `users`,
  `user_identifiers`, `user_roles`, `auth_sessions`, `audit_log`;
- files (Messaging V1): `file_assets`;
- messaging (Messaging V1): `conversations`, `conversation_participants`,
  `messages`, `message_attachments` — see [messaging.md](messaging.md) §2
  for what each constraint guarantees;
- notifications (Notifications V1): `notifications`,
  `notification_preferences`, `notification_devices` — see §3 below and
  [notifications.md](notifications.md);
- academic (Academic Core V1): `academic_sections`, `academic_programs`,
  `academic_halaqat`, `academic_enrollments`, `academic_teacher_assignments`
  — see §3 below and [academic.md](academic.md) §4 and §10.

No table references another module's table: account and file ids are plain
columns, never cross-module foreign keys (a test asserts it). Inside a
module, foreign keys are `RESTRICT` where history refers to a row.

---

## 1. Drizzle, and the reason it is not Prisma

Full reasoning in
[decisions/0008-drizzle-over-prisma.md](decisions/0008-drizzle-over-prisma.md).
The short form is a boundary argument, not a taste argument:

Prisma requires **one global `schema.prisma`**. Every module's tables in one
file, edited by everyone, with no mechanism preventing a query in `messaging`
from joining `operations`' tables. That single file would quietly undo the
module boundaries the rest of this architecture spends its effort enforcing.

Drizzle lets each module declare its tables beside the adapter that uses them:

```
src/modules/identity/infrastructure/schema.ts   ← identity owns these tables
src/platform/audit/schema.ts                    ← platform owns this one
```

and `drizzle.config.ts` collects them by glob:

```ts
schema: ['./src/platform/**/schema.ts', './src/modules/*/infrastructure/schema.ts']
```

Table ownership now matches module ownership, and a module can be extracted
with its schema intact.

### The deliberate cost

`platform/database` creates the Drizzle handle **without a registered schema**:

```ts
export type Database = NodePgDatabase<Record<string, never>>;
```

Platform must not know what tables exist — `platform-knows-no-modules` forbids
it. The consequence is that Drizzle's relational query API (`db.query.users...`)
is unavailable. The select/insert builder, which is what repositories actually
use, is unaffected.

That is a real trade: a convenience API given up to keep an architectural rule
true. It is recorded here so the next person does not "fix" it by importing
every module's schema into platform.

---

## 2. Migrations

```bash
npm run db:generate   # diff the schema files → drizzle/NNNN_*.sql
npm run db:migrate    # apply pending migrations
```

Four rules:

1. **Generated SQL is committed and reviewed.** A migration is code: it gets
   read before it runs.
2. **Nothing auto-migrates on boot.** Applying schema changes is a deliberate
   deployment step, not a side effect of a pod restarting. An app that migrates
   on startup will eventually have three replicas migrating at once.
3. **Migrations are forward-only.** No `down`. A mistaken migration is corrected
   by a new one.
4. **Destructive changes are split across steps.** Add, then move the data, then
   remove, so that each step can be verified independently.

### How Identity & Access V1 was migrated — and why in three steps

| Migration | Kind | Does |
| --- | --- | --- |
| `0000_…` | generated | Foundation: `users` (with `email`), `user_roles`, `audit_log` |
| `0001_access_foundation` | generated, **additive only** | new tables; `users.password_changed_at` |
| `0002_seed_access_catalog` | **custom data** | seeds roles, permissions and the provisional matrix; copies every email into `user_identifiers` |
| `0003_tighten_identity` | generated **+ two hand-written steps** | drops `users.email`; new status vocabulary; FK `user_roles → roles` |

Three steps rather than one, for two reasons:

- **Data has to move between the add and the drop.** Emails move to
  `user_identifiers` after that table exists and before `users.email` goes.
  Statuses and role codes are rewritten after the old CHECK is dropped and
  before the new one and the new FK are added. `0003` marks its two inserted
  data steps `HAND-WRITTEN`.
- **drizzle-kit asks interactively about renames** when one diff both adds and
  drops a column in the same table. Keeping each generated migration purely
  additive or purely subtractive means it never asks.

The seed SQL in `0002` was **generated from the TypeScript constants**, not
transcribed, and a test asserts the database and the constants agree.

### Messaging V1 — two steps

| Migration | Kind | Does |
| --- | --- | --- |
| `0004_messaging_and_files` | generated, **additive only** | `file_assets` and the four messaging tables, with their uniques, CHECKs, FKs and partial indexes |
| `0005_seed_messaging_permissions` | **custom data**, generated from constants | `messaging.start_direct`, `create_group`, `create_channel`, and their provisional grants |

### Notifications V1 — one step

| Migration | Kind | Does |
| --- | --- | --- |
| `0006_notifications` | generated, **additive only** (plus a header comment) | the three notification tables, with their uniques, CHECKs and partial indexes; no foreign keys |

### Academic Core V1 — two steps

| Migration | Kind | Does |
| --- | --- | --- |
| `0007_academic_core` | generated, **additive only** (plus a header comment) | the five academic tables, with their uniques, CHECKs, `RESTRICT` foreign keys inside the module and the two partial unique "one ACTIVE" indexes; no foreign key to another module |
| `0008_seed_academic_permissions` | **custom data**, generated from constants | `academic.teach`, `academic.study`, and their provisional grants |

**The institution's structure is not in a migration.** Sections, programs and
halaqat are institutional data that administrators change; they are seeded
by an explicit, idempotent command (`npm run academic:seed-structure`) that
creates what is missing by code and never overwrites — see
[academic.md §11](academic.md). Reference data a migration may carry is the
kind code depends on (permissions); data people edit is not.

`drizzle-kit generate` against the committed schema reports no changes — the
migrations and the schema files agree.

### Migrations are tested against old data, not just an empty database

`test/integration/migration-upgrade.spec.ts` builds the schema as of `0000`,
fills it with Foundation-era rows in the old vocabulary (`invited`,
`administrator`, a `parent` assignment), applies everything after, and checks
each row arrived correctly: emails moved, `invited` → `PENDING`,
`administrator` → `ADMIN`, the inactive `parent` assignment dropped, constraints
in force. An empty database only proves the DDL parses.

---

## 3. The schema, and why each decision was made

### Access catalogue — `roles`, `permissions`, `role_permissions`

The runtime source of truth for authorization. `roles.code` is the FK target
for assignments, so only a role that exists can be held, and a new role is a
migration rather than a deploy. `role_permissions` is the matrix that runs,
currently provisional (see [authorization.md §4](authorization.md)). Codes are
shape-checked by CHECK constraints (`^[A-Z][A-Z0-9_]{1,63}$` for roles,
`namespace.action` for permissions).

### `users`

| Column | Notes |
| --- | --- |
| `id` | text PK. Generated by `IdGenerator`, not by a database sequence |
| `display_name` | |
| `status` | text + CHECK: `PENDING` · `ACTIVE` · `SUSPENDED` · `DISABLED` |
| `password_hash` | `$scrypt$N$r$p$salt$hash` |
| `password_changed_at` | Distinct from `updated_at`: a re-hash is not a change |
| `created_at`, `updated_at` | timestamptz |

**No email column.** Identifiers are their own table (below).

**Ids are application-generated**, so an entity is complete and valid before it
is persisted, and a use case can reference it in an event without a round trip.

**Statuses are a CHECK, not a Postgres enum.** Widening a CHECK is a cheap
re-validation; altering an enum type is a locking migration.

### `user_identifiers`

PK `(kind, value)`. **That primary key is the uniqueness guarantee:** an
identifier belongs to at most one account. Values are stored normalized (NFC,
trimmed, lower-cased) by the domain, so the guarantee is case-insensitive.
Normalization lives in one place rather than being duplicated in a functional
index. Two administrators creating the same email at once can't both succeed.
The loser gets `identifier_taken` as an outcome, not an exception, and no
half-written account (tested). Indexed on `user_id` for loading an account's
identifiers.

### `user_roles`

PK `(user_id, role)`, FK `role → roles.code ON DELETE RESTRICT`: a role people
hold cannot be deleted out from under them (tested). Each row records
`granted_at` and `granted_by`. `granted_by` is deliberately not a FK, because
attribution must survive the granter's deletion. Indexed on `role` for "who
holds this role?".

*Corrected from the Foundation:* it had a separate index on `user_id`, which the
PK's leading column already serves. That index is dropped.

`save()` writes role changes **as a diff**. The Foundation deleted and
re-inserted every role on every save, so an unrelated password change rewrote
when each role had been granted. Tested.

### `auth_sessions`

See [session-management.md](session-management.md). Hashes of the current and
previous refresh token, never a raw token. CHECK constraints: the platform
vocabulary, the revocation-reason vocabulary, "revoked iff a reason is given",
"expires after creation", "generation ≥ 0". A **partial index**
`(user_id) WHERE revoked_at IS NULL` serves the hot queries without scanning
dead sessions.

### `notifications`, `notification_preferences`, `notification_devices`

Owned by **notifications**. What each guarantee is for:

| Constraint / index | Guarantees |
| --- | --- |
| `notifications_dedupe_unique (recipient_user_id, dedupe_key)` | one notification per source fact and recipient — the idempotency of the whole pipeline. The insert is `ON CONFLICT DO NOTHING RETURNING`, so the constraint, not a prior read, decides |
| `notifications_recipient_created_idx (recipient_user_id, created_at, id)` | the inbox page: a keyset range scan, read backwards for newest first. **Ascending on purpose** — a backward scan yields `ORDER BY created_at DESC, id DESC` (NULLS FIRST); a `DESC NULLS LAST` index cannot serve that order, as the first draft of this migration found (the `EXPLAIN` test caught it) |
| `notifications_recipient_unread_idx … WHERE read_at IS NULL` | the unread count (at most 100 rows read) and "mark all read" in chunks — both only ever touch unread rows |
| CHECKs: type and category shape, template keys `notification.<x>.<y>`, `params` a JSON object, `target` an object with a string `kind`, dedupe key length, `read_at ≥ created_at` | the database refuses what the domain refuses, whoever writes |
| `notification_preferences` PK `(user_id, category)` | one row per person and category; no row means the defaults |
| `notification_devices_token_unique (provider, token)` | one owner per app installation; registering again updates the row (and may move it to the account now signed in) |
| `notification_devices_user_enabled_idx (user_id, last_seen_at) WHERE disabled_at IS NULL` | a page of recipients' devices in one query; the least recently seen found cheaply for eviction |
| CHECKs: platform, provider, APNs only on iOS, token length 32–1024 | no malformed registration survives a buggy caller |

Account ids are plain columns: suspending or disabling an account leaves its
notification history alone.

### `academic_sections`, `academic_programs`, `academic_halaqat`, `academic_enrollments`, `academic_teacher_assignments`

Owned by **academic**. What each guarantee is for:

| Constraint / index | Guarantees |
| --- | --- |
| `academic_*_code_unique`, `*_code_shape` | one row per stable code; codes are lower-case slugs, 2–64 characters — the identifiers routes and seeds share (names are never keys) |
| `academic_enrollments_active_unique (student_user_id, halaqa_id) WHERE status = 'ACTIVE'` | one current enrollment per student and halaqa, while history accumulates; enrolling is `INSERT … ON CONFLICT DO NOTHING`, so the index, not a prior read, decides |
| `academic_teacher_assignments_active_unique (halaqa_id, teacher_user_id) WHERE status = 'ACTIVE'` | the same for teaching |
| `…_section_id_…_fk`, `…_program_id_…_fk`, `…_halaqa_id_…_fk` — all `ON DELETE RESTRICT` | nothing history refers to can be deleted, even by hand |
| CHECKs: kind, status, role vocabularies; `(status = 'ACTIVE') = (ended_at IS NULL)`; `ended_at ≥ enrolled_at / started_at`; name, description and position ranges | the database refuses what the domain refuses, whoever writes |
| `academic_enrollments_halaqa_idx (halaqa_id, status, enrolled_at, id)` | a halaqa's roster by status, keyset-paged |
| `academic_enrollments_student_idx (student_user_id, enrolled_at, id)` | a student's history and current enrollments |
| `academic_teacher_assignments_halaqa_idx (halaqa_id, status, started_at, id)` · `…_teacher_idx (teacher_user_id, started_at, id)` | a halaqa's teachers; a teacher's assignments |
| `academic_programs_section_idx`, `academic_halaqat_program_idx (parent, sort_order, code)` | a section's programs and a program's halaqat, in order |

Enrollment locks its halaqa, program and section rows `FOR SHARE`;
deactivating a halaqa locks it `FOR UPDATE` — so no enrollment slips into a
halaqa as it closes. Account ids are plain columns: suspending an account
leaves its enrollments alone.

> **Proposed change:** see
> [communities.md §5.2](communities.md#52-counters-and-version-allocation)
> and the
> [global lock order](communities-live-attendance.md#52-the-global-lock-order-communities)
> (approved design, [ADR 0016](decisions/0016-communities-module.md) Accepted).
> The proposed `communities` tables would take a per-aggregate,
> commit-ordered version from `communities.membership_version` under the
> community row lock, as messaging takes `conversations.last_sequence`
> under the conversation row lock today. Every communities transaction
> would take its locks in one global order, with the community row the last
> existing row it locks.

### `audit_log`

Owned by **platform**. Now written by `DrizzleAuditLog` whenever a database is
configured. Append-only: the adapter has no update or delete path. Indexed for
the two questions an audit log answers: what did this person do, and what
happened to this record.

---

## 4. Repositories

Every repository implements a port the **domain** declares, and has an
in-memory twin for unit tests and database-less development:

| Port | Postgres | Memory |
| --- | --- | --- |
| `UserRepository` | `DrizzleUserRepository` | `InMemoryUserRepository` |
| `AuthSessionRepository` | `DrizzleAuthSessionRepository` | `InMemoryAuthSessionRepository` |
| `RoleCatalog` | `DrizzleRoleCatalog` | `InMemoryRoleCatalog` (the provisional matrix) |
| `AuditLog` | `DrizzleAuditLog` | `LoggingAuditLog` |
| `FileAssetRepository` | `DrizzleFileAssetRepository` | `InMemoryFileAssetRepository` |
| `MessagingRepository` (writes) | `DrizzleMessagingRepository` | `InMemoryMessagingStore` |
| `MessagingReadModel` (pages) | `DrizzleMessagingReadModel` | `InMemoryMessagingStore` (the same instance) |
| `NotificationRepository` | `DrizzleNotificationRepository` | `InMemoryNotificationRepository` |
| `PreferenceRepository` | `DrizzlePreferenceRepository` | `InMemoryPreferenceRepository` |
| `DeviceRepository` | `DrizzleDeviceRepository` | `InMemoryDeviceRepository` |
| `AcademicRepository` (writes) | `DrizzleAcademicRepository` | `InMemoryAcademicStore` |
| `AcademicReadModel` (lists) | `DrizzleAcademicReadModel` | `InMemoryAcademicStore` (the same instance) |

Selected once per module, keyed on whether `DATABASE_URL` was supplied.

The in-memory twins enforce the **same invariants** the schema does: identifier
uniqueness, compare-and-swap rotation, never un-revoking. A use case therefore
cannot pass against memory and then fail against Postgres on a rule the fake
forgot. The full sign-in → rotate → replay flow also runs against the Drizzle
adapters on real Postgres.

---

## 5. What is tested on real PostgreSQL

`TEST_DATABASE_URL` enables them. Each suite creates **its own fresh database**,
built only by the committed migrations, and drops it afterwards. Suites are
isolated from each other and from earlier runs. Without the variable they skip
and say so on stderr; CI always sets it.

- **Catalogue integrity:** roles, permissions and the matrix in the database
  equal the constants in code.
- **Constraints:** unknown role refused (FK); held role undeletable (RESTRICT);
  status outside the vocabulary refused (CHECK); session CHECKs; cascades on
  account deletion.
- **Repositories:** identifier uniqueness under the PK, atomic create, role
  diffs preserving grants, keyset paging, compare-and-swap rotation,
  never-un-revoke, first-reason-wins, live-session counting.
- **The flow:** sign-in, rotation, replay detection and session termination on
  real SQL, asserting no raw token appears anywhere in the table.
- **Migrations from old data** (above).
- **Messaging under concurrency:** twenty simultaneous DM creations for one
  pair yield one conversation; fifty simultaneous sends get sequences 1…50;
  twelve retries of one send store one row; racing adds never exceed the cap;
  `member_count` equals the current members; concurrent read marks end at the
  highest; a removed member is refused at append.
- **Messaging's database guards:** each unique, FK and CHECK refuses what it
  exists to refuse, without the repository in the way.
- **Messaging at volume:** keyset paging over 2,000 messages returns each once;
  the timeline query uses `Index Scan Backward` on
  `messages_conversation_sequence_unique` among 12,000 rows; unread counts stop
  at the cap; fan-out pages a channel's members.
- **Files:** completion is exactly-once under concurrent calls; storage keys
  are unique.
- **The use cases end to end over Drizzle** — a group, text, an image with a
  verified upload, read state and the list.
- **Realtime end to end on PostgreSQL** — the production application booted
  against a migrated database, real WebSocket clients: a message stored, then
  delivered with its stored id and sequence; three sent while a member was
  disconnected, recovered by `after` paging; a removed member receiving
  nothing more; a lost event filled from the database; nobody — the owner
  included — receiving a conversation they are not in. Fan-out's "who can see
  this sequence" is also tested on the read model directly.
- **Notifications:** each constraint refuses what it exists to refuse, by
  name; no foreign key reaches another module's table; twenty concurrent
  dispatches of one request store one row and publish one event; a messaging
  fact translated three times concurrently is one row per recipient; keyset
  paging walks one person's 3,500 rows (of 5,000 in the table) each once,
  newest first, and `EXPLAIN` shows `notifications_recipient_created_idx`
  with no sequential scan; the capped unread count uses the partial index;
  "mark all" in chunks alongside a concurrent single read counts each row
  once; devices register, refresh, move between accounts and are disabled,
  and one token registered concurrently from two accounts is one row; a
  connected, disconnected and reconnected recipient on a real WebSocket.
- **Academic:** every constraint and index by name; foreign keys only inside
  the module, all `RESTRICT`, none to an account; the checks refuse what the
  domain never writes; history cannot be deleted from under its references;
  twenty simultaneous enrollments of one student in one halaqa make one row
  and one audit entry; simultaneous assignments make one ACTIVE row; two
  administrators ending one enrollment at once end it once; enrollment racing
  a halaqa's deactivation never leaves an ACTIVE enrollment in an INACTIVE
  halaqa (25 rounds); a cap and a code hold under contention; forty-six
  enrollments of one student page newest first, each once; `EXPLAIN` shows
  the roster, history and teacher lookups on their indexes; the seed writes
  the structure once, keeps an administrator's change and runs concurrently
  without duplicates; migrations 0007–0008 on a database already in use add
  their tables and grants and touch nothing else.

---

## 6. Redis

Configured, not yet used. The boundary is fixed now because it is the one that
gets violated under deadline.

**Redis may hold:** cache entries, ephemeral realtime state, **rate-limit
counters** (the production home of the `RateLimiter` port), job queues.

Realtime V1 did not need it: live connections are per instance, in memory,
and the database stays the only record of any message (realtime.md §M10
says what changes with several instances).

**Redis must never hold permanent business truth.** Sessions are in Postgres,
not Redis. A session is a security record, and "who was signed in when" must
survive a cache flush.

---

## 7. Connection management

One pool per process, `max: 10`, created in `platform/database` and closed on
shutdown. `DatabaseModule` is composed explicitly by `AppModule`, so a unit test
never opens a pool by accident. Replicas × pool size is the number to compare
with Postgres's `max_connections`.

---

## 8. Deliberately deferred

- Postgres adapters for `live` (rooms, sessions, moderation). These are
  in-memory today.
- Retention for notifications (Q27): kept indefinitely today.
- A unit of work spanning a state change and its audit entry. Today the audit
  write follows the change and can, in principle, fail after it
  (observability.md).
- A cleanup job for revoked and expired sessions (Q3).
- Read replicas, partitioning, the transactional outbox.
- Any schema for the six contract-only modules.

> **Correction (2026-09-23):** five modules are contract only: `people`,
> `operations`, `assignments`, `automation` and `reporting`, as
> [module-boundaries.md](module-boundaries.md) says. `live` is implemented,
> in memory; its Postgres adapters are the first item above.
