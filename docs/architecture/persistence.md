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
  for what each constraint guarantees.

No table references another module's table: account and file ids are plain
columns, never cross-module foreign keys (a test asserts it).

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
- The `FileAsset` table: there is no upload endpoint for it to serve yet.
- A unit of work spanning a state change and its audit entry. Today the audit
  write follows the change and can, in principle, fail after it
  (observability.md).
- A cleanup job for revoked and expired sessions (Q3).
- Read replicas, partitioning, the transactional outbox.
- Any schema for the eight contract-only modules.
