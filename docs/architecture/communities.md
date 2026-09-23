# Communities

**State: APPROVED (2026-09-23) — implemented in phases: P2 (core) and P3 (delegation).** What a phase has not delivered does not exist yet; [the hub's §25](communities-live-attendance.md#25-implementation-phases) records which phases have landed.

The design of the `communities` module: the Community aggregate, membership,
invitation links, the OPEN/LOCKED lifecycle (phase **P2**), and delegated
capabilities with ownership transfer (phase **P3**). It is one part of the
Communities + Live + Attendance package; the overview, dependency graph,
realtime matrix and phases are in the hub,
[communities-live-attendance.md](communities-live-attendance.md). Decisions are
recorded in [ADR 0016](decisions/0016-communities-module.md) (the module) and
[ADR 0017](decisions/0017-community-scoped-authorization.md) (authorization and
delegation), both Accepted (2026-09-23).

**Implementation is gated.** The communities module is a new module, and
[academic-reconciliation.md §13](academic-reconciliation.md#13-minimal-recommended-changes-before-the-next-milestone)
asks, "before any new module", for answers to Q35 and Q36 and for ADR 0015
(academic-reconciliation.md:483-493). Whether that gate covers this module is
[Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules);
the provisional default is that it does. The P0 corrections (guards, the 503
failure kind, the academic migration pin) come first either way
([§17](#17-module-layout-and-architecture-specs)).

**Every default below is PROVISIONAL** and names the open question that
decides it. Nothing here decides an institutional policy.

> **P2 landed (2026-09-23).** The Communities core is implemented in
> `backend/src/modules/communities/` with the layout of [§17](#17-module-layout-and-architecture-specs),
> migrations `0009_seed_communities_permissions` and `0010_communities`
> ([§5.5](#55-migrations)), and the routes of [§12](#12-api) except the P3
> grant and ownership routes. Implemented as designed: stints, invitation
> links with only the token's SHA-256 stored, OPEN/LOCKED with the
> [§8.3](#83-statepermits-and-communityheadeffects) tables, the evaluator of
> [§6.5](#65-the-evaluator) with the membership, owner and oversight bases,
> `COMMUNITY_AUTHORIZATION` (`authorize`, `authorizeEach`),
> `COMMUNITY_MEMBERSHIP` (all five reads), `COMMUNITY_DIRECTORY`, every
> transaction in the [§4](#the-global-lock-order) lock order behind the
> per-community admission mutex, one deadlock retry, and 503 `unavailable`
> for a store or directory outage. Not yet, by phase: the grant basis,
> `COMMUNITY_CAPABILITY_HOLDERS`, grants and transfer (P3);
> `COMMUNITY_CHAT_READ_CEILING` (P4); `permittedAmong` and
> `community.live.remain` (P6). No consumer uses the contracts yet.
>
> Choices the design left to implementation, all technical rather than
> policy:
>
> - Creating a community checks `communities.moderate` as well as
>   `communities.create`: the creator becomes owner, and [§6.7](#67-the-owner)
>   makes ownership require it. Today's role matrix makes the two coincide.
> - Codes the design did not name: 403 `communities.person_required` (a system
>   principal can neither own nor join, having no stint); 422
>   `communities.members_invalid` (the 1–200 bound, for callers that bypass the
>   DTO); 429 `communities.too_many_additions` and
>   `communities.too_many_invitations`. Member adds are limited to 60 requests
>   per 10 minutes per person (PROVISIONAL, [Q26](open-questions.md#q26--realtime-limits)).
> - The oversight listing of every community is audited once per page, with
>   resource id `*`.
> - The authorization statement may be served by `community_members_user_idx`
>   instead of `community_members_current_unique` when the planner judges the
>   person's memberships few. Both are one bounded probe keyed by community
>   and person; the scale suite accepts either and checks the index condition
>   names both.
> - The 503 mapping is a platform interceptor
>   (`DatabaseUnavailableInterceptor`) that the two Communities controllers opt
>   into. It maps connection-class failures only; any other error is still a 500.
> - After an independent review of P2:
>   - Failed queries are logged without their bind values, so a statement
>     timeout during a redemption cannot write the token's hash
>     ([observability.md](observability.md#secret-redaction)).
>   - Every refusal of [§7.2](#72-lookup) now answers as the design says: a
>     missing, mistyped or oversized token is 404 `communities.invitation_invalid`,
>     and the per-address join limit is 429 `communities.too_many_attempts`.
>     The platform `@RateLimit` takes an optional code. A title over 100
>     characters is 422 `communities.title_invalid`; any cursor this API did not
>     issue is 422 `communities.cursor_invalid`; an oversized `limit` is clamped.
>   - Deadlock retries are counted (`deadlockRetries`) and logged. The
>     concurrency suite asserts the count stays zero under every race, because a
>     retry that succeeds would otherwise hide a deadlock.
>   - The in-memory store re-verifies the basis before it looks for the
>     community, as the transaction does.
>   - Both adapters must refuse a lost basis without writing anything
>     (including undoing a revocation already written), and must undo a link's
>     use when its creator no longer stands as owner.
>
> Evidence: `test/integration/communities-postgres.spec.ts` (constraints, the
> [§7.4](#74-race-semantics) races through six store instances, the contract
> suite shared with the in-memory store), `communities-scale.spec.ts` (about
> 900,000 stint rows, 30,000 and 100,000 members, `EXPLAIN` of the statements
> actually sent), `communities-migrations.spec.ts`, the application and API
> suites, and `test/architecture/communities-boundaries.spec.ts`.

---

## 1. Terminology

The brief's **"Group"** is the **Community** aggregate in code: module
`communities`, ids `communityId`, routes `/communities`, tokens `COMMUNITY_*`,
events `communities.*`, acts `community.*`. The word "group" is not used,
because it already means messaging's `GROUP` conversation type
(`messaging/contracts/vocabulary.ts:11`) and is used for Tahajji's «مجموعة»
in [Q36](open-questions.md#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups).
A module name must not answer Q36. "Group" remains the brief's product word
only.

| Term | Code | What it is |
| --- | --- | --- |
| Community (the brief's Group) | `Community`, table `communities` | A persistent space that lasts months or years. It is never a LiveKit room and never derived from one |
| Stint | a `community_members` row | One stay of one account in one community, from joining to leaving or removal. A rejoin is a new stint |
| Standing | `OWNER` \| `MEMBER` on the stint | Belonging, and the one ownership mark. Not a role, not a capability |
| Owner | the stint whose standing is `OWNER` | Exactly one per community |
| Ceiling | an identity permission (`communities.*`, `live.*`, `messaging.*`) | Role-wide. Required on every path to an act; never sufficient alone |
| Act | `CommunityAct` (`community.*`) | Something one may do in one community: a delegable **capability**, a **participation** act, or a **derived** act (`community.live.host`, `community.live.remain`) |
| Grant (P3) | a `communities_capability_grants` row | One capability given by the owner to one member's stint |
| Basis | `membership` \| `owner` \| `grant` \| `oversight` | Why a permit was given |
| Oversight | `communities.manage` | Institutional reach into a community one does not belong to |
| Invitation link | a `community_invitations` row plus a bearer token | Only the token's SHA-256 is stored |
| Lifecycle status | `OPEN` \| `LOCKED` | `ARCHIVED` is deferred ([§8](#8-lifecycle-open-and-locked)) |
| «مجموعة» | not modelled | Tahajji's word; what it is stays Q36 |
| حلقة (halaqa) | academic's `Halaqa` | Not linked to a community in v1 ([§18](#18-relation-to-academic-q50)) |
| Live session | Live's `LiveSession` | Belongs to Live and references a community by id ([live.md](live.md)) |

---

## 2. What exists today, and what this module reuses

**Today there is no communities module**, and no community, invitation, invite
link or lock concept anywhere in the backend or the app. The backend modules
are academic, assignments, automation, files, identity, live, messaging,
notifications, operations, people, realtime and reporting.

What exists today that this design depends on or reuses:

| What exists today | Where | Used here for |
| --- | --- | --- |
| Identity permission shape `^[a-z]+[.][a-z_]+$`, enforced by a DB CHECK | `identity/infrastructure/schema.ts:36` | The four new ceilings pass it; the brief's `group.members.invite` would not ([§6.2](#62-identity-ceilings)) |
| "Adding a permission is a code change AND a migration" | `identity/contracts/permissions.ts:16-17` | Data migration 0009 |
| Identity's policy rules are internal; exports are three tokens | `identity.module.ts:150`, `:181` | Communities cannot contribute a rule ([§6.13](#613-why-identity-gets-no-per-resource-acl)) |
| The one registered rule, `host-only-moderation`, deny-overrides on a caller-supplied `ownerUserId` | `provisional-policy.ts:139-141`; `policy.ts:50`, `:75-87` | Retired in P6, not by this module ([§6.12](#612-how-live-messaging-and-attendance-ask)) |
| Permission AND module-owned relationship | `academic-access.ts:68-84`; `conversation-access.ts:58-72` | The evaluator's shape |
| A non-member is told "not found", exactly like a missing resource | `conversation-access.ts:14-18`, `:26-35` | `communities.community_not_found` |
| "A permission never substitutes for membership"; `messaging.manage` removes, never adds | `messaging/application/security.spec.ts:16`, `:103` | Oversight never adds ([§6.11](#611-oversight-communitiesmanage)) |
| History rows under a partial unique "one ACTIVE" index | academic `schema.ts:212-214` | Stints |
| A member count kept in the same transaction | `drizzle-messaging-repository.ts:254`, `:293` | `member_count` |
| Transaction-scoped advisory locks | `drizzle-academic-repository.ts:51-53` | The per-pair lock |
| Audit, then event, nothing on a no-op | `academic-journal.ts:11-39` | `CommunitiesJournal` |
| SHA-256 of a 256-bit secret | `crypto-secure-token-generator.ts:7-21` | Invitation tokens |
| The logger redacts a body key `token`; URLs are redacted only in query parameters | `logger-options.ts:9-28`, `:34-39` | The token travels in a POST body only |
| Postgres or in-memory adapter chosen by configuration | `academic.module.ts:78-97` | Mock mode keeps working |
| The Principal is rebuilt from storage on every request | `resolve-principal.use-case.ts:69-89` | Demotion takes effect on the next request |
| Messaging's owner can neither leave nor transfer | `membership.use-cases.ts:297-305` | Transfer is designed here (P3) |

Existing gaps this design depends on P0 to close: the vendor-SDK rule never
fires (`.dependency-cruiser.cjs:79-90`); no failure kind maps to 503
(`shared/result.ts:21-28`, `http-failure.ts:12-20`); the academic upgrade test
asserts an exact grant delta after migrating to the latest migration
(`academic-postgres.spec.ts:580`); the architecture lists are hand-written
(`authorization.spec.ts:79-94`). See the hub for the full P0 list.

**What this module changes in existing code, when built:** identity gains four
catalogue leaves and data migration 0009; `app.module.ts` registers
`CommunitiesModule`; the architecture lists gain the module. Nothing else.
Messaging, Live and Realtime change in their own phases (P4–P7).

---

## 3. Domain model

```
 Community ──1:n──▶ Stint (community_members) ──▶ account id (identity)
   status OPEN|LOCKED     status ACTIVE|LEFT|REMOVED, standing OWNER|MEMBER,
   lifecycle_version      source ADDED|INVITATION, version
   membership_version            │
   member_count                  └──1:n──▶ CapabilityGrant (P3)
     │                                        capability, end_reason
     └──1:n──▶ Invitation
                 token_hash, expires_at, max_uses, uses, revoked_at
```

All domain code is pure TypeScript in `communities/domain`. It imports only
`communities/contracts`, `identity/contracts/permissions.ts` and `src/shared`,
never `node:crypto`, drizzle or `@nestjs`.

### 3.1 The Community aggregate

The root is small and never holds its members.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid v4 | From `ID_GENERATOR` |
| `title` | string | Trimmed, 1–100 characters, no control or bidi-override characters (technical bound, matching `TITLE_MAX_LENGTH`, `messaging-policy.ts:17`) |
| `status` | `OPEN` \| `LOCKED` | Meaning in [§8](#8-lifecycle-open-and-locked) |
| `lifecycleVersion` | integer ≥ 1 | +1 on each real status change; lets consumers drop stale lock frames |
| `membershipVersion` | integer ≥ 0 | The last version allocated to a membership change ([§5.2](#52-counters-and-version-allocation)) |
| `memberCount` | integer ≥ 0 | Maintained counter; no upper bound |
| `createdBy`, `createdAt`, `statusChangedAt`, `statusChangedBy`, `updatedAt` | | Attribution |

**No owner column** (ownership is standing on a stint, §3.2), **no `kind`**
(nothing in Communities behaves differently by kind, and a kind would pre-answer
Q36), **no halaqa link** ([§18](#18-relation-to-academic-q50)). A community is
**never deleted**: the repository has no delete, there is no DELETE route, and
foreign keys are `RESTRICT`
([Q47](open-questions.md#q47--retiring-a-community)).

### 3.2 Membership stints

One row per stay, following academic's enrollments. This replaces messaging's
one-row-per-pair upsert, which overwrites the previous stay's `addedBy` and
`leftAt`.

| Field | Notes |
| --- | --- |
| `id` | Stable surrogate. Grants are keyed to it, so a rejoin never revives a grant |
| `communityId`, `userId` | `userId` is identity's id; no foreign key across modules |
| `status` | `ACTIVE` → `LEFT` \| `REMOVED`. Terminal; a rejoin is a new stint |
| `standing` | `OWNER` \| `MEMBER`. Changes only by transfer (P3) |
| `source` | `ADDED` (a manager added them) \| `INVITATION` (they redeemed a link). `SYNC` is reserved for Q50 and is not in the CHECK |
| `addedBy` | Null for a self-join through a link |
| `invitationId` | Non-null exactly when `source = INVITATION` |
| `joinedAt`, `endedAt`, `endedBy` | `endedAt` is null exactly while ACTIVE |
| `version` | The community-wide version of this row's latest change; unique per community, in commit order |

```
  ∅ ──manager add (ADDED) | link redemption (INVITATION)──▶ ACTIVE ──leave──▶ LEFT
                                                             └──remove──▶ REMOVED
  standing:  MEMBER ──transfer in──▶ OWNER ──transfer out──▶ MEMBER   (P3)
```

Rules, all PROVISIONAL:

- The owner cannot leave (412 `communities.owner_cannot_leave`) or be removed
  (412 `communities.owner_not_removable`) while owner
  ([Q42](open-questions.md#q42--community-ownership)).
- An account whose latest stint is `REMOVED` cannot rejoin through a link
  (403 `communities.rejoin_requires_manager`); a manager may re-add them
  directly. `LEFT` accounts may rejoin by link
  ([Q49](open-questions.md#q49--leaving-removal-and-rejoining)).
- A suspended or disabled account keeps its stint untouched; it cannot act
  because it cannot authenticate
  ([Q13](open-questions.md#q13--what-do-suspended-and-disabled-mean-and-who-may-move-an-account-between-them)).

### 3.3 Invitation

| Field | Notes |
| --- | --- |
| `id`, `communityId` | |
| `tokenHash` | 64 lowercase hex characters: SHA-256 of the 43-character token. The token itself is never stored |
| `createdBy`, `createdAt` | |
| `expiresAt` | Required. PROVISIONAL default 7 days, minimum 5 minutes, maximum 30 days ([Q48](open-questions.md#q48--invitation-links)) |
| `maxUses` | Optional; null means unlimited until expiry; otherwise 1–2,147,483,647 (an integer bound, not policy) |
| `uses` | Increases only in the transaction that creates the INVITATION stint |
| `revokedAt`, `revokedBy` | One-way |

The state is **derived, never stored** (only revocation, a human act, is
stored), evaluated with the application clock in this order:

```
 REVOKED    revokedAt ≠ null
 EXPIRED    now ≥ expiresAt
 EXHAUSTED  maxUses ≠ null and uses ≥ maxUses
 ACTIVE     otherwise
```

"Suspended" (the community is LOCKED) is a redemption-time condition, not a
state: the link is neither consumed nor revoked. No sweeper job exists or is
needed.

### 3.4 Capability grant (P3)

A separate small aggregate, never inside the Community, so a grant never locks
the community row.

| Field | Notes |
| --- | --- |
| `id`, `communityId`, `membershipId`, `userId` | `(membershipId, communityId, userId)` must equal the stint's (composite foreign key) |
| `capability` | One `CommunityCapability` |
| `grantedBy`, `grantedAt` | The owner |
| `endedAt`, `endedBy`, `endReason` | `revoked` \| `membership_ended` \| `ownership_changed` |

```
 none ──grant (owner)──▶ ACTIVE ──revoke (owner)──────────────▶ ENDED 'revoked'
                              ├──stint ends (same transaction)──▶ ENDED 'membership_ended'
                              └──grantee becomes owner─────────▶ ENDED 'ownership_changed'
```

ENDED is terminal; a re-grant is a new row. **Dormant** is not a state: it is
the evaluation outcome when the holder no longer has the ceiling
([§6.10](#610-how-grants-end-and-dormancy)).

### 3.5 Invariants, and who enforces them

| Invariant | Domain / application | Database |
| --- | --- | --- |
| At most one ACTIVE stint per (community, user) | per-pair advisory lock | partial unique `community_members_current_unique` |
| Exactly one owner, and the owner is ACTIVE | created with the community; transfer demotes then promotes in one transaction | partial unique `community_members_owner_unique`; CHECK `community_members_owner_active` |
| `memberCount` = number of ACTIVE stints | same transaction as every stint start and end | conditional `UPDATE` of the community row; asserted under concurrency |
| Membership versions unique and in commit order | allocated under the community row lock | `UNIQUE (community_id, version)` |
| `endedAt` set exactly when not ACTIVE, never before `joinedAt` | `greatest(at, joined_at)` on write | CHECKs `…_ended_consistent`, `…_ended_after_joined` |
| `source = INVITATION` ⇔ `invitationId` set | | CHECK `…_source_consistent` |
| `uses ≤ maxUses` | conditional `UPDATE` | CHECK `…_uses_within_limit` (backstop) |
| Revocation is one-way | `UPDATE … WHERE revoked_at IS NULL` | |
| LOCKED ⇒ no new stint | lifecycle table | `status = ANY($accepting)` in the same conditional `UPDATE` |
| At most one ACTIVE grant per (stint, capability) (P3) | idempotent grant | partial unique `…_grants_active_unique` |
| A grant's community and user are its stint's (P3) | | composite foreign key |
| No self-grant; closed vocabulary (P3) | domain rule | CHECKs |
| A grant on an ended stint is never effective (P3) | evaluation joins only the ACTIVE stint; grants ended in the same transaction | |
| A community is never deleted | no delete path | `RESTRICT` foreign keys |

---

## 4. Aggregate and consistency boundaries

| Unit | Consistency boundary | Serialized by | Never |
| --- | --- | --- | --- |
| Community (the `communities` row) | status, `lifecycle_version`, `membership_version`, `member_count` | the row itself, through conditional `UPDATE`s | holds or loads its members |
| Stint (per community and user) | one ACTIVE stint; standing | per-pair advisory lock in the two-key form, `pg_advisory_xact_lock(<communities lock class>, hashtext('<community>:<user>'))`, a key space academic's single-key locks never share; the partial unique index | is loaded as a collection |
| Invitation | `uses ≤ max_uses`; one-way revocation | the invitation row, through one conditional `UPDATE` | stores a derived state |
| Grant (P3) | one ACTIVE grant per (stint, capability) | the partial unique index; the owner's and grantee's stint rows `FOR SHARE` | locks the community row |
| Ownership (P3) | exactly one ACTIVE owner | the one-owner index and the owner-is-active CHECK; the two stint rows `FOR UPDATE` | a column on `communities` |

**Cross-aggregate invariants are kept in one transaction**, never by events:
a join moves the invitation row, the community row and a new stint together;
a stint's end ends its grants in the same transaction. **Cross-module
consistency is never transactional**: Messaging, Live and Attendance ask
`COMMUNITY_AUTHORIZATION` at their own decision point, and at most the one
request that already held a permit completes after a revocation commits. Its
audit entry records the permit it relied on.

**Why ownership is not a column.** The community row is the hottest row in a
30,000-member community: every join, leave and removal updates it (count and
version), and so do lock and unlock. With an owner column, every use case that
re-verifies ownership under lock would share-lock that row. As standing on the
stint, ownership is a CHECK plus a partial unique index, and grant, revoke and
transfer never touch the community row.

### The global lock order

Every Communities transaction acquires locks in this order, and only in this
order:

1. **per-pair advisory locks**, sorted by the computed lock key and
   deduplicated (not by user id: two pairs whose 32-bit hashes collide would
   otherwise be taken in opposite orders by two batch adds, and deadlock);
2. **the invitation row**;
3. **existing stint rows**, in ascending id;
4. **grant rows**;
5. **the community row** — the last existing row locked. Its `UPDATE`
   allocates membership versions and moves `member_count`;
6. **new rows**: stint, invitation or grant inserts.

No transaction takes `FOR SHARE` on a row and later updates that row (two such
transactions deadlock). Grant, revoke and transfer never reach step 5. Evaluation
takes no locks. A deadlock victim retries once, then answers 409
`communities.conflict`; the concurrency suite runs under a `statement_timeout`,
so a deadlock fails a test instead of hanging it.

Before step 1, and before it checks out a pool connection, every transaction
that reaches step 5 takes an in-process async mutex keyed by the community id
([§9](#9-membership-at-30000-and-beyond), hot rows). It is admission, not
correctness: it is taken while no database lock is held, a transaction takes
only one, so it closes no cycle with the order above, and the database still
decides every invariant.

| Transaction | 1 pair | 2 invitation | 3 stints | 4 grants | 5 community | 6 insert |
| --- | --- | --- | --- | --- | --- | --- |
| Create community | | | | | (inserted) | community, owner stint |
| Add members (≤ 200) | each (C,u), sorted by key | | actor `SHARE` | actor's grant `SHARE` | `UPDATE` +n, n versions | stints |
| Redeem a link | (C,U) | `UPDATE` uses | creator `SHARE` | creator's grant `SHARE` (P3) | `UPDATE` +1, 1 version | stint |
| Remove a member | (C,target) | | actor `SHARE`, target `UPDATE` | actor's grant `SHARE`; target's grants `UPDATE` | `UPDATE` −1, 1 version | |
| Leave | (C,self) | | own `UPDATE` | own grants `UPDATE` | `UPDATE` −1, 1 version | |
| Lock / unlock | | | actor `SHARE` (not on oversight) | actor's grant `SHARE` | `UPDATE` status | |
| Create a link | | | actor `SHARE` | actor's grant `SHARE` | | invitation |
| Revoke a link | | `UPDATE` revoked | actor `SHARE` (not on oversight) | actor's grant `SHARE` | | |
| Grant (P3) | | | owner, grantee `SHARE` | | | grants |
| Revoke a grant (P3) | | | owner `SHARE` | `UPDATE` | | |
| Transfer (P3) | | | owner, target `UPDATE` | target's grants `UPDATE` | | |

"Every capability-authorized mutation re-verifies its basis under lock"
(ADR 0017): the actor's stint `FOR SHARE`, plus the actor's grant `FOR SHARE`
when the basis is `grant`. A concurrent revocation (`UPDATE` of that grant) or
removal (`FOR UPDATE` of that stint) therefore serializes with the act: the act
either commits first, authorized at that instant, or re-reads its basis as
ended and is refused.

---

## 5. Persistence

**Proposal only.** No migration, table or seed is created by this package.
All tables are private to Communities; user ids are plain text with no foreign
key into another module (pinned by a `pg_constraint` test, as academic does).
Everything runs at READ COMMITTED, the project default.

### 5.1 Tables

**`communities`**

| Column | Type | Constraint |
| --- | --- | --- |
| `id` | text PK | |
| `title` | text NOT NULL | CHECK `communities_title_length`: `char_length(title) BETWEEN 1 AND 100` |
| `status` | text NOT NULL | CHECK `communities_status_valid`: `status IN ('OPEN','LOCKED')` |
| `lifecycle_version` | integer NOT NULL DEFAULT 1 | CHECK `>= 1` |
| `membership_version` | bigint NOT NULL DEFAULT 0 | CHECK `>= 0` |
| `member_count` | integer NOT NULL DEFAULT 0 | CHECK `communities_member_count_nonnegative`: `>= 0`. **No upper bound** |
| `created_by` | text NULL | |
| `created_at` | timestamptz NOT NULL | |
| `status_changed_at`, `status_changed_by` | timestamptz NULL, text NULL | |
| `updated_at` | timestamptz NOT NULL | CHECK `updated_at >= created_at` |

**`community_members`** — one row per stint

| Column | Type | Constraint |
| --- | --- | --- |
| `id` | text PK | |
| `community_id` | text NOT NULL | → `communities(id)` `RESTRICT` |
| `user_id` | text NOT NULL | no foreign key (identity's) |
| `status` | text NOT NULL | CHECK `IN ('ACTIVE','LEFT','REMOVED')` |
| `standing` | text NOT NULL DEFAULT `'MEMBER'` | CHECK `IN ('OWNER','MEMBER')` |
| `source` | text NOT NULL | CHECK `IN ('ADDED','INVITATION')` |
| `added_by` | text NULL | |
| `invitation_id` | text NULL | → `community_invitations(id)` `RESTRICT` |
| `joined_at` | timestamptz NOT NULL | |
| `ended_at`, `ended_by` | timestamptz NULL, text NULL | |
| `version` | bigint NOT NULL | CHECK `> 0` |

Row CHECKs: `community_members_ended_consistent` `(status = 'ACTIVE') = (ended_at IS NULL)`;
`community_members_ended_after_joined` `ended_at IS NULL OR ended_at >= joined_at`;
`community_members_source_consistent` `(source = 'INVITATION') = (invitation_id IS NOT NULL)`;
`community_members_owner_active` `standing <> 'OWNER' OR status = 'ACTIVE'`;
`community_members_left_by_self` `status <> 'LEFT' OR ended_by = user_id`.

**`community_invitations`**

| Column | Type | Constraint |
| --- | --- | --- |
| `id` | text PK | |
| `community_id` | text NOT NULL | → `communities(id)` `RESTRICT` |
| `token_hash` | text NOT NULL | UNIQUE `community_invitations_token_hash_unique`; CHECK `token_hash ~ '^[0-9a-f]{64}$'` |
| `created_by` | text NOT NULL | |
| `created_at` | timestamptz NOT NULL | |
| `expires_at` | timestamptz NOT NULL | CHECK `expires_at > created_at` |
| `max_uses` | integer NULL | CHECK `max_uses IS NULL OR max_uses >= 1` |
| `uses` | integer NOT NULL DEFAULT 0 | CHECK `community_invitations_uses_within_limit`: `uses >= 0 AND (max_uses IS NULL OR uses <= max_uses)` |
| `revoked_at`, `revoked_by` | timestamptz NULL, text NULL | CHECK `revoked_at IS NULL OR revoked_at >= created_at` |

There is no status column.

**`communities_capability_grants`** (P3)

| Column | Type | Constraint |
| --- | --- | --- |
| `id` | text PK | |
| `community_id`, `membership_id`, `user_id` | text NOT NULL | FOREIGN KEY `(membership_id, community_id, user_id)` → `community_members (id, community_id, user_id)` |
| `capability` | text NOT NULL | CHECK `IN (` the seven capabilities of [§6.3](#63-the-act-vocabulary) `)`; widened by a CHECK migration in P9 |
| `granted_by` | text NOT NULL | CHECK `granted_by <> user_id` (no self-grant) |
| `granted_at` | timestamptz NOT NULL | |
| `ended_at`, `ended_by` | timestamptz NULL, text NULL | CHECK `ended_by IS NULL OR ended_at IS NOT NULL`; CHECK `ended_at IS NULL OR ended_at >= granted_at` |
| `end_reason` | text NULL | CHECK `IN ('revoked','membership_ended','ownership_changed')`; CHECK `(ended_at IS NULL) = (end_reason IS NULL)` |

Rows are never deleted. A terminal stamp is set once, by
`UPDATE … WHERE ended_at IS NULL`. Retention of ended stints, revoked links and
ended grants follows
[Q3](open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history).

### 5.2 Counters and version allocation

Every membership change — a join, an add, a leave, a removal — updates the
community row in the same transaction:

```
UPDATE communities
   SET member_count       = member_count ± n,
       membership_version = membership_version + n,
       updated_at         = greatest(updated_at, $at)
 WHERE id = $c [AND status = ANY($accepting)]        -- the gate, for joins and adds only
RETURNING membership_version                          -- the new stints get the last n values
```

The row lock is held until commit, so a transaction that allocates version
*v + 1* cannot commit before the one that allocated *v*. The versions in
`community_members` are therefore **unique and in commit order**, and
`community_members` is an ordered, resumable changefeed: a reader that has
applied everything up to *v* sees every later change by asking for
`version > v`. When a stint ends, its row's `version` is raised to the newly
allocated value; a row's version only ever increases. This is the same
technique as messaging's `conversations.last_sequence`.

`lifecycle_version` is separate: lock and unlock move it and never touch
`membership_version`. Grant, revoke and transfer move neither.

`count(*)` never runs in a request path. The Postgres suite asserts
`member_count = count(ACTIVE)` under concurrency.

### 5.3 Indexes, one query each

| Index | Serves |
| --- | --- |
| `communities` PK | `heads(ids)`; `listHeads` keyset by id; the authorization statement |
| `communities_created_idx (created_at, id)` | the oversight listing of all communities, keyset |
| UNIQUE `community_members_current_unique (community_id, user_id) WHERE status = 'ACTIVE'` | the arbiter of one current stint; the authorization probe; `members()` keyset by user id |
| UNIQUE `community_members_owner_unique (community_id) WHERE standing = 'OWNER'` | one owner; the owner row of `COMMUNITY_CAPABILITY_HOLDERS` |
| UNIQUE `community_members_version_unique (community_id, version)` | `changesSince` |
| UNIQUE `community_members_stint_key (id, community_id, user_id)` | target of the grants' composite foreign key |
| `community_members_roster_idx (community_id, joined_at, user_id) WHERE status = 'ACTIVE'` | roster pages |
| `community_members_user_idx (user_id, joined_at, community_id) WHERE status = 'ACTIVE'` | "my communities", newest first |
| `community_members_history_idx (community_id, user_id, version DESC)` | `statesOf` (latest stint per user); the rejoin rule |
| `community_members_invitation_idx (invitation_id) WHERE invitation_id IS NOT NULL` | who joined through a given (possibly leaked) link |
| `community_invitations_token_hash_unique` | redemption lookup |
| `community_invitations_community_idx (community_id, created_at, id)` | a community's links, keyset |
| UNIQUE `communities_capability_grants_active_unique (membership_id, capability) WHERE ended_at IS NULL` | idempotent grant; the authorization probe; the "me" block |
| `communities_capability_grants_active_by_community (community_id, capability, user_id) WHERE ended_at IS NULL` | holders; the owner's grant list |
| `communities_capability_grants_active_by_user (user_id, community_id) WHERE ended_at IS NULL` | a holder's own grants |

The query shapes:

| Question | Statement |
| --- | --- |
| May P do act A in C? | One statement on the primary: `communities` by id `LEFT JOIN` P's ACTIVE stint `LEFT JOIN` the ACTIVE grant for A (for `community.live.host`, the grant for `community.live.start`). Two unique-index probes, whatever the size |
| The "me" block | The same, with `array_agg` over the stint's ACTIVE grants (at most one per capability) |
| Roster page | `WHERE community_id = $c AND status = 'ACTIVE' AND (joined_at, user_id) > ($a, $b) ORDER BY joined_at, user_id LIMIT n + 1` |
| `members()` | `… AND user_id > $cursor [AND user_id = ANY($only)] [AND user_id <> $exclude] ORDER BY user_id LIMIT n + 1` |
| `statesOf` | `SELECT DISTINCT ON (user_id) … WHERE community_id = $c AND user_id = ANY($ids) ORDER BY user_id, version DESC` |
| Which of these users may do A in C? (`permittedAmong`, P6) | One statement: `communities` by id, the ids' ACTIVE stints through `community_members_current_unique`, their ACTIVE grants for A; then one `ACCOUNT_DIRECTORY.withPermission` per ceiling permission, and `statePermits` |
| `changesSince` | One statement: the community's head plus `WHERE community_id = $c AND version > $v ORDER BY version LIMIT n + 1`, collapsed to the highest version per user |
| My communities | `community_members` (user index) joined once to `communities` for title, status and count. No N+1 |
| Holders (P3) | Keyset union by user id of the owner row and ACTIVE grants for the capability, then one `ACCOUNT_DIRECTORY.withPermission` call per ceiling permission per page |

**"Latest stint" means the highest `version`, never the latest `joined_at`.**
The injected clock may step back (hence the `greatest(…)` guards on writes);
versions never do, and a stint ends before its successor starts, so its
version is always lower. Ordering by `joined_at` would, after a clock step
back, report an ACTIVE member as inactive and send a repeat redemption into
the partial unique index (500 instead of 200).

No list uses `OFFSET`. Cursors are opaque base64url strings, as in
`academic/application/cursors.ts`. Display names come from one
`AccountDirectory.describe` call per page (at most 1,000 ids), never one per
row.

### 5.4 No ceiling as policy

`member_count` has no upper CHECK and no constant anywhere limits community
size. The only bounds are technical: at most 200 user ids per add request (it
keeps the community-row lock short, mirroring `MAX_PARTICIPANTS_PER_REQUEST`,
`messaging-policy.ts:27`), API pages of at most 200, contract pages of at most
1,000. Messaging's conversation caps do not apply. If the institution decides a
limit
([Q20](open-questions.md#q20--messaging-limits), which also covers community
size), it is a nullable Communities configuration value enforced in the same
conditional `UPDATE` that increments `member_count`. The 100,000-member fixture
([§16](#16-tests)) proves that nothing depends on 30,000.

### 5.5 Migrations

- **0009** — identity data migration, in the 0008 pattern: the four
  `communities.*` permissions and their PROVISIONAL grants, generated from the
  TypeScript constants. It gets its own upgrade test asserting its exact grant
  delta; P0 pins the academic upgrade test to `migrateTo(scratch.db, 9)`.
- **The next free number** — the communities schema (three tables), generated
  from `communities/infrastructure/schema.ts`, additive only (P2).
- **A later number** — `communities_capability_grants` (P3), and in P9 a CHECK
  migration adding the two attendance capabilities.

---

## 6. Authorization

### 6.1 The rule

```
effective(P, C, act) = identity ceiling(act)
                   AND Communities standing(P, C, act)
                   AND lifecycle gate(status of C, act)
```

This is the existing ceiling-plus-relationship pattern: `academic.teach` AND an
ACTIVE teaching assignment (`academic-access.ts:68-84`); a `messaging.*`
permission AND current membership (`conversation-access.ts:58-72`). A grant
only ever **narrows** what identity allows. Identity's `AuthorizationService`,
`AuthorizationContext`, `Principal` and `AccountDirectory` do not change.

### 6.2 Identity ceilings

Four leaves are added to identity's catalogue (30 → 34):

| Permission | Means | PROVISIONAL holders |
| --- | --- | --- |
| `communities.read` | Take part in communities one belongs to; eligibility to become a member by any path; the edge permission of most `/communities` routes | all six active roles ([Q41](open-questions.md#q41--what-is-a-community-and-who-may-create-one)) |
| `communities.create` | Create a community; the creator becomes its owner | OWNER, ADMIN ([Q41](open-questions.md#q41--what-is-a-community-and-who-may-create-one)) |
| `communities.moderate` | Grants nothing by itself, like `academic.teach`. Eligibility to own a community or hold any delegable capability | TEACHER, plus OWNER and ADMIN ([Q44](open-questions.md#q44--who-may-hold-delegated-capabilities)) |
| `communities.manage` | Institutional oversight without membership ([§6.11](#611-oversight-communitiesmanage)) | OWNER, ADMIN ([Q43](open-questions.md#q43--institutional-oversight-of-communities)) |

**Why these names pass the catalogue shape.** Each has exactly two segments: a
letters-only namespace, `communities`, and an action in `[a-z_]+`. They match
`^[a-z]+[.][a-z_]+$` (`identity/infrastructure/schema.ts:36`) and the
one-level flatten of `ALL_PERMISSIONS` (`permissions.ts:102-104`). The
namespace is a capability area, not a module (`permissions.ts:9-10`). The
brief's `group.members.invite` has three segments and fails the CHECK, its
unit test (`permissions.spec.ts:8-10`) and the flatten; it would also be
role-wide, not "in group G".

OWNER holds all four by construction; ADMIN holds all four through
`ALL_PERMISSIONS.filter` (`provisional-policy.ts:42-45`), which the
no-escalation constraint requires (`provisional-policy.ts:19-30`). New
`role.spec` invariants: `communities.create ⇒ communities.moderate ⇒
communities.read`, and `communities.manage ⇒ communities.read`, so every
creator is an eligible owner. A realtime coupling test pins that every role
holding `communities.read` also holds `messaging.read`, the realtime connection
gate (`realtime-sessions.ts:443`;
[Q66](open-questions.md#q66--realtime-without-messagingread)).
`identity-persistence.spec.ts:84-117` keeps the seeded tables equal to the
constants.

### 6.3 The act vocabulary

Owned by Communities, closed, in `communities/contracts/capabilities.ts`:

| Act | Kind | The brief's candidate | Asked by |
| --- | --- | --- | --- |
| `community.view` | participation | — | Communities |
| `community.members.view` | capability | `group.members.view` | Communities (roster) |
| `community.members.invite` | capability | `group.members.invite` | Communities (links, direct add) |
| `community.members.remove` | capability | `group.members.remove` | Communities |
| `community.lock` | capability (lock and unlock) | `group.lock` | Communities |
| `community.chat.read` | participation | — | Messaging |
| `community.chat.post` | capability | — | Messaging |
| `community.live.start` | capability | `group.live.start` | Live |
| `community.live.host` | derived, backed by `community.live.start` | — | Live |
| `community.live.moderate` | capability | `group.live.moderate` | Live |
| `community.live.join` | participation | — | Live |
| `community.live.remain` | derived (P6): the ceiling and basis of `community.live.join`, gated by `runningLiveContinues` | — | Live (reconciler, through `permittedAmong`) |
| `community.live.raise_hand` | participation | — | Live |
| `community.attendance.record`, `community.attendance.view` | **reserved**; added in P9 by a CHECK migration | `group.attendance.*` | Attendance ([attendance.md](attendance.md)) |
| `community.messages.moderate` | **reserved** until Q51/Q23 | `group.messages.moderate` | — |

Participation acts are satisfied only by ACTIVE membership, never by a grant.
Screen share and the speaker grant are per-session Live state and are never
community acts ([live.md](live.md)).

**The two vocabularies are disjoint, and a verification note.** An earlier
draft of this design stated that every act has three segments and so can never
pass identity's shape CHECK. That holds for eleven acts but **not** for
`community.view` and `community.lock`, which have two segments and match
`^[a-z]+[.][a-z_]+$`. Disjointness therefore rests on three guards, each
tested: `isPermission(act)` is false for every act (no act is catalogued, and
`can()` denies an uncatalogued permission); no identity namespace is
`community` (singular); and the TypeScript unions `CommunityAct` and
`Permission` share no member, so passing an act to `AuthorizationService` does
not compile. The names stay as this package fixes them.

### 6.4 Act rules — PROVISIONAL

A constant in `communities/domain`, not exported, with a banner like
`provisional-policy.ts`. A ceiling lists identity permissions that are **all**
required.

| Act | Standing ceiling | Owner holds it implicitly | Oversight ceiling | While LOCKED |
| --- | --- | --- | --- | --- |
| `view` | `communities.read` | as a member | `communities.manage` | yes |
| `members.view` | `communities.moderate` | yes | `communities.manage` | yes |
| `members.invite` | `communities.moderate` | yes | none | no |
| `members.remove` | `communities.moderate` | yes | `communities.manage` | yes |
| `lock` | `communities.moderate` | yes | `communities.manage` | never blocked |
| `chat.read` | `communities.read` + `messaging.read` (`COMMUNITY_CHAT_READ_CEILING`, [§10](#10-public-contracts)) | as a member | none | yes |
| `chat.post` | `communities.moderate` + `messaging.send` | yes | none | no |
| `live.start` | `communities.moderate` + `live.moderate` | yes | none | no |
| `live.host` | as `live.start` | as `live.start` | none | while `runningLiveContinues` |
| `live.moderate` | `communities.moderate` + `live.moderate` | yes | none | yes |
| `live.join` | `communities.read` + `live.join` | as a member | none | yes |
| `live.remain` (P6) | as `live.join` | as a member | none | while `runningLiveContinues` |
| `live.raise_hand` | `communities.read` + `live.raise_hand` | as a member | none | yes |

(`community.` prefixes omitted.) Decided by
[Q43](open-questions.md#q43--institutional-oversight-of-communities) (oversight
reach), [Q44](open-questions.md#q44--who-may-hold-delegated-capabilities)
(ceilings), [Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock)
(the LOCKED column), [Q51](open-questions.md#q51--the-community-chat-who-may-post)
(who posts) and [Q54](open-questions.md#q54--who-starts-ends-and-moderates-a-live-session)
(who starts and moderates). Answering any of them edits this table and its
pinning test; no consumer changes.

### 6.5 The evaluator

`CommunityAuthorizationService` implements `COMMUNITY_AUTHORIZATION` over one
pure domain function, `decideCommunityAct(rule, facts)`. Communities' own use
cases call the same evaluator. The order is fixed:

| Step | Check | Failure | HTTP |
| --- | --- | --- | --- |
| 1 | **Ceiling.** In memory, before any read: does P hold the standing ceiling, or the oversight ceiling if the act has one? Context `{resourceType: 'communities.community', resourceId: C, attributes: {act}}` | `forbidden` `identity.permission_denied`. Nothing is read, so nothing leaks | 403 |
| 2 | **One read** on the primary: the community's status, P's ACTIVE stint (id, standing, joinedAt, version), the ACTIVE grant for the act | a store failure rejects the promise | 503 `unavailable` (P0) |
| 3 | **Standing.** First match wins: **membership** (participation act, ACTIVE stint, standing ceiling held); **owner** (capability, standing OWNER, standing ceiling held); **grant** (capability, ACTIVE grant, standing ceiling held); **oversight** (oversight ceiling set and held) | | |
| 4 | The community is missing; or no basis and P has no ACTIVE stint — the two answers are identical | `not_found` `communities.community_not_found` | 404 |
| 4′ | No basis, P is a member | `forbidden` `communities.capability_required` `{act}` | 403 |
| 5 | **Lifecycle gate.** `statePermits(status, act)` ([§8.3](#83-statepermits-and-communityheadeffects)); never blocks `community.lock` | `precondition_failed` `communities.community_locked` | 412 |

The result is a `CommunityPermit` naming the principal, community, act,
scope, basis, stint, grant and the ceiling held on the path taken. Every act
performed on a permit copies `{act, basis, membershipId, grantId}` into its
audit metadata. Invariants:

- **Stateless.** No cache across requests, only a per-request memo. Reads go to
  the primary, because replica lag would bring revoked powers back.
- **Fail closed.** A store failure is never answered from roles alone; callers
  answer 503.
- **System principals** never have a stint. They can take the oversight basis
  only if constructed with `communities.manage`.
- **Communities never passes `ownerUserId`** to identity, so no identity rule
  can fire on its ceiling checks — the `host-only-moderation` rule does not
  apply to them even before P6 retires it (`policy.ts:75-87`).
- `attributes: {act}` is unused by identity today
  (`identity/contracts/authorization.ts:18`); it lets a future identity DENY
  rule (a legal hold, a safeguarding block) match an act.

### 6.6 Which act each Communities operation asks

| Operation | Act | Bases admitted |
| --- | --- | --- |
| Create a community | none: identity `communities.create` | — |
| List my communities | none: my own ACTIVE stints | — |
| List all communities | none: identity `communities.manage` | oversight (audited) |
| View a community | `community.view` | membership, oversight |
| List members | `community.members.view` | owner, grant, oversight |
| Add members | `community.members.invite` | owner, grant — oversight never adds |
| Create a link | `community.members.invite` | owner, grant |
| List or revoke links | `community.members.invite` | owner, grant, **and oversight** (see note) |
| Remove a member | `community.members.remove` | owner, grant (plus R6, §6.8), oversight |
| Leave | `community.view` | membership; the owner is refused |
| Lock, unlock | `community.lock` | owner, grant, oversight |
| List, create, end grants (P3) | owner standing (R1) | owner; a holder may list their own |
| Transfer ownership (P3) | owner standing, or `communities.manage` | owner, oversight (not to oneself) |

**Reconciliation note.** The act rules of [§6.4](#64-act-rules--provisional)
give `community.members.invite` no oversight path and refuse it while LOCKED,
while [Q43](open-questions.md#q43--institutional-oversight-of-communities),
[Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock) and
[Q48](open-questions.md#q48--invitation-links) let a `communities.manage`
holder list and revoke links (to kill a leaked link) but never create one, and
keep revoking links open while LOCKED. Both hold if the rules table carries an
**operation-level override** for the two operations "list links" and "revoke a
link" only: oversight through `communities.manage` is admitted, and the
lifecycle gate treats them as management (allowed while LOCKED). The exported
vocabulary does not change, and no new act name is introduced.

### 6.7 The owner

- Ownership is standing on the owner's ACTIVE stint. It is not a capability
  and not a grant. It is the only manager concept: no MANAGER or MODERATOR
  membership role exists, because the brief (§3) allows one only where
  justified, and delegation is expressed as individual grants.
- Exactly one owner, created in the community's creation transaction.
- The owner **implicitly holds every capability within its ceilings**
  (PROVISIONAL, [Q42](open-questions.md#q42--community-ownership)): an owner
  who lacks `live.moderate` does not start sessions; one who lacks
  `messaging.send` does not post.
- In v1 the owner alone grants, revokes and transfers (R1).
- Eligibility, at creation and at transfer: an ACTIVE account holding
  `communities.moderate`.
- A creator is always a person: system principals never hold a stint, so v1
  has no system creation path (`createdBy` is nullable only for symmetry with
  the journals).

If the owner loses `communities.moderate`, or is suspended, the owner-implicit
capabilities go **dormant** on the next request (the Principal is rebuilt,
`resolve-principal.use-case.ts:69-89`). Existing grants keep working within
their holders' ceilings, and nothing can be granted until ownership is
recovered by transfer ([§6.9](#69-transfer)). If no ACTIVE member is eligible,
there is no recovery path
([Q42](open-questions.md#q42--community-ownership)).

### 6.8 Delegation, and the no-escalation rule (P3)

Pure domain functions (`mayDelegate`, `mayGrant`, `mayRemove`, `mayTransfer`),
the analogue of identity's `canGrantRole` (`identity/domain/administration.ts:17-37`),
reimplemented because that file is identity-internal.

| Rule | Statement | Enforced by |
| --- | --- | --- |
| R1 | Only the current owner grants and revokes; no sub-delegation ([Q44](open-questions.md#q44--who-may-hold-delegated-capabilities)) | domain rule under lock |
| R2 | **No escalation**: the grantor must effectively hold the capability — for the owner, hold its ceiling | in-memory ceiling check before the transaction |
| R3 | The grantee is an ACTIVE member, not the owner, and an ACTIVE account holding every ceiling permission of the capability. Unknown, inactive, non-member and ineligible grantees are refused alike (422 `communities.grantee_ineligible`) | `withPermission`; stint re-read under lock |
| R4 | Ceilings are re-checked at every evaluation; a lost ceiling makes a grant dormant, never deleted | the evaluator |
| R5 | No self-grant | CHECK `granted_by <> user_id` |
| R6 | A non-owner holding `community.members.remove` may remove M only if M is not the owner and M's ACTIVE grants (dormant ones included) are a subset of the remover's effective capabilities | domain rule under lock |
| R7 | Granting an ACTIVE (stint, capability) pair again is a no-op returning the existing grant | partial unique index; `ON CONFLICT DO NOTHING` |

A grant in community A gives nothing in community B: it is bound to a stint of
exactly one community (composite foreign key), and evaluation uses the target
community's id. Becoming a live speaker grants no community act.

### 6.9 Transfer

`PUT /communities/:communityId/owner {userId}`, by the owner (basis `owner`) or
by a `communities.manage` holder (basis `oversight`) naming someone other than
themself (PROVISIONAL separation of duties,
[Q42](open-questions.md#q42--community-ownership)).

1. The target must be an ACTIVE member whose account is ACTIVE and holds
   `communities.moderate` (`withPermission`, before the transaction).
2. In one transaction: lock the current OWNER stint and the target's ACTIVE
   stint `FOR UPDATE` in ascending id; re-read; demote the owner to MEMBER,
   then promote the target (a partial unique index cannot be deferred); end the
   target's ACTIVE grants with `ownership_changed`.
3. The old owner becomes MEMBER with no grants. The one-owner index is the
   backstop for two concurrent transfers; the loser gets 409
   `communities.owner_conflict`.

Repeating a transfer to the current owner answers 200 and records nothing.

### 6.10 How grants end, and dormancy

| Cause | Effect |
| --- | --- |
| The owner revokes | `ENDED 'revoked'`; event and audit `communities.capability.revoked` |
| The holder leaves or is removed | `ENDED 'membership_ended'` in the same transaction; implied by `communities.member.removed` (no per-grant event) |
| The holder becomes owner | `ENDED 'ownership_changed'`; listed in `communities.ownership.transferred` |
| The holder loses the ceiling, or is suspended | **Dormant**: still ACTIVE, not effective; the owner's grant list shows `dormant: true`; effective again if the role is restored |
| The granting owner hands over ownership | Nothing: grants survive a transfer ([Q45](open-questions.md#q45--capability-grants-duration-handover-and-visibility)) |
| LOCKED | Nothing: the lifecycle gates acts, it does not end grants |

Grants do not expire (Q45). Nothing is announced to members; only the affected
user receives a `community.access.changed` frame (P5).

### 6.11 Oversight (`communities.manage`)

PROVISIONAL reach ([Q43](open-questions.md#q43--institutional-oversight-of-communities)):

| May | May not |
| --- | --- |
| view a community; list all communities | add members |
| list its members | create links |
| lock and unlock | read its chat |
| list and revoke its links | act in its live sessions |
| remove members | view its attendance |
| transfer ownership, not to oneself | |

This follows messaging's precedent: a permission never substitutes for
membership, and `messaging.manage` removes but never adds
(`messaging/application/security.spec.ts:16`, `:103`). **Oversight never
adds**: every entry path requires `community.members.invite` on the owner or
grant basis. Every read on the oversight basis is audited (PROVISIONAL,
[Q43](open-questions.md#q43--institutional-oversight-of-communities)).
Overseers are never listed as capability holders.

### 6.12 How Live, Messaging and Attendance ask

Each consumer keeps its coarse identity check at the edge, loads its own
record, and then asks `COMMUNITY_AUTHORIZATION` with the community id **read
from its own stored record, never from the client**. It remaps `not_found` to
its own not-found code, so a non-member learns nothing. Each consumer's side is
designed in its own document: [community-chat.md](community-chat.md)
([ADR 0018](decisions/0018-community-chat-projection.md)),
[live.md](live.md) ([ADR 0019](decisions/0019-community-scoped-live-sessions.md))
and [attendance.md](attendance.md)
([ADR 0020](decisions/0020-attendance-snapshots.md)).

| Consumer | Edge permission | Asks | Notes |
| --- | --- | --- | --- |
| Messaging, read a community chat | `messaging.read` | `community.chat.read` | Every request; list views through `authorizeEach` ([community-chat.md](community-chat.md)). Principal-less recipient pages are narrowed by `COMMUNITY_CHAT_READ_CEILING`: two `withPermission` calls per community-chat page ([community-chat.md §7.3](community-chat.md#73-who-receives-a-message-the-lag-filter)) |
| Messaging, post | `messaging.send` | `community.chat.post` | Refusal is the existing 403 `messaging.posting_not_allowed`. Then Messaging's capacity switch: above `communityChatMaxServedMembers`, 412 `messaging.community_chat_over_capacity`. `canPost` is the permit and the switch together ([community-chat.md §7.2](community-chat.md#72-may-this-principal-send)) |
| Live, start | `live.moderate` | `community.live.start` | The starter becomes host ([live.md](live.md)) |
| Live, join / raise hand | `live.join` / `live.raise_hand` | `community.live.join` / `community.live.raise_hand` | Non-member → 404 `live.session_not_found` |
| Live, moderate | `live.moderate` | `community.live.moderate`; else, if P is the host, `community.live.host` | Replaces the identity call with `ownerUserId`; `PROVISIONAL_POLICY_RULES` becomes `[]` in the same change (P6, ADR 0017) |
| Attendance, record / view (P9, HELD) | per [attendance.md](attendance.md) | record: `community.attendance.record`, then `community.live.moderate`, then (the session's host) `community.live.host`; view: `community.attendance.view`, then (the host or a recorder of that session) `community.view` | The fallback order of [attendance.md §11.3](attendance.md#113-attendanceaccess-how-refusals-map), PROVISIONAL ([Q69](open-questions.md#q69--who-records-and-who-views-snapshots)): a `forbidden` answer moves to the next act, so `communities.capability_required` is not mapped to 403 while a fallback remains. Ceilings use no `attendance.*` permission |

No consumer reads a community's raw status. Principal-less consumers (sync,
reconcilers, relays) read `CommunityHead.effects`; one that must know which
of several users may do an act asks `COMMUNITY_AUTHORIZATION.permittedAmong`
(P6), never `COMMUNITY_MEMBERSHIP`, and keeps no copy of the act rules.

### 6.13 Why identity gets no per-resource ACL

ADR 0005 rejected per-resource ACLs as "wrong for an institution whose access
model is fundamentally role-shaped" (`0005-authorization-architecture.md:86-88`),
and that stands. Resource standing lives in the module that owns the resource,
exactly as academic and messaging already do. Rejected alternatives:

- **Scoped `user_roles` or a grants table in identity**: reverses ADR 0005,
  teaches identity what a community is, and grows the Principal with every
  membership.
- **Communities contributing a `PolicyRule`**: rules are synchronous and see
  only caller-supplied context (`policy.ts:20-29`), so they cannot look up a
  grant; `POLICY_RULES` is internal (`identity.module.ts:150`); and an
  identity → communities provider edge would close a cycle with
  communities → identity.
- **Three-segment identity permissions**: would change the DB CHECK, its unit
  test and the flatten, and the result would still be role-wide.

### 6.14 Not every teacher can lock every community

The TEACHER role supplies **ceilings only** (`communities.read`,
`communities.moderate`, and the existing `live.*`). PROVISIONAL reading of the
brief's "teacher" ([Q44](open-questions.md#q44--who-may-hold-delegated-capabilities),
[Q50](open-questions.md#q50--communities-and-the-academic-structure)): the
teacher of C is C's owner or a member holding grants in C; the teacher of a
session is its host. The alternative, teaching assignments conferring
capabilities, is Q50. A TEACHER without standing in C:

| Tries to, in C | Answer |
| --- | --- |
| lock, invite, remove, list members | 404 `communities.community_not_found` if not a member; 403 `communities.capability_required` if a member without the grant |
| start or moderate a live session | Live's 404 / 403 through the same permit |
| use a grant held in community B | refused: grants are bound to one community's stint |

A test pins this matrix
([§16](#16-tests)).

---

## 7. Invitation links

The flow is [S2 and S3 in §13](#13-sequences).

### 7.1 The token

- 32 random bytes, base64url: 43 characters, 256 bits. Generated by an
  internal `InvitationSecrets` port implemented in
  `communities/infrastructure` with `node:crypto` (the domain may not import
  it). Identity's generator is identity-internal, so the ~20 lines are
  reimplemented rather than widening identity.
- **Only SHA-256 hex is stored**, under a unique index. A 256-bit secret needs
  neither a slow KDF nor a salt, and lookup needs a deterministic hash — the
  identity refresh-secret reasoning (`crypto-secure-token-generator.ts:7-21`).
- **Shown once**, in the 201 response of `POST …/invitations`. List responses
  carry metadata only. The token is never stored, logged, audited, published
  or retrievable again.
- On a hash collision (probability about 2⁻²⁵⁶) the use case issues once more;
  a second collision is a fault (500), never silently reused.

### 7.2 Lookup

`POST /communities/join {token}`. The token travels **only in the JSON body
under the key `token`**, which the logger already redacts
(`logger-options.ts:9-28`). It is never in a path or a query string: URLs are
redacted only in query parameters (`logger-options.ts:34-39`), and link
scanners prefetch GET URLs, which would consume uses. A token in the query
string is ignored. The route takes **no community id**: the token identifies
the community, so there is no mismatch case and no enumeration surface.

Before the transaction: the per-user rate limit; the shape check (exactly 43
base64url characters; anything else is answered like an unknown token);
`h := sha256(token)`; one indexed lookup by `token_hash` returning the
invitation id, its community and its creator; and the creator's ceiling,
`withPermission([createdBy], communities.moderate)`, from P2 (it is the
ceiling of `community.members.invite` on the owner and grant bases alike).

### 7.3 Redemption

One READ COMMITTED transaction, in the global lock order:

```
BEGIN
  -- 1  pair lock: serializes everything that changes (C, U)
  SELECT pg_advisory_xact_lock($communities_lock_class, hashtext($c || ':' || $u));

  -- the redeemer's latest stint (stable under the pair lock)
  SELECT status FROM community_members
   WHERE community_id = $c AND user_id = $u ORDER BY version DESC LIMIT 1;
     ACTIVE  -> COMMIT  -> already_member   (200; no use consumed; nothing recorded)
     REMOVED -> ROLLBACK -> removed         (403 communities.rejoin_requires_manager)

  -- 2  the invitation row: gate and increment in one statement
  UPDATE community_invitations SET uses = uses + 1
   WHERE id = $l AND revoked_at IS NULL AND expires_at > $at
     AND (max_uses IS NULL OR uses < max_uses)
  RETURNING uses;
     0 rows  -> ROLLBACK; re-read $l with the same $at -> revoked | expired | exhausted

  -- 3, 4  the creator still holds community.members.invite, under lock
  SELECT id, standing FROM community_members
   WHERE community_id = $c AND user_id = $k AND status = 'ACTIVE' FOR SHARE;
  SELECT id FROM communities_capability_grants            -- (P3) only when standing <> 'OWNER'
   WHERE membership_id = $k_stint AND capability = 'community.members.invite'
     AND ended_at IS NULL FOR SHARE;
     neither -> ROLLBACK -> creator_lost   (404 communities.invitation_invalid)
     -- P2: the creator's stint must be the ACTIVE OWNER; P3 adds the grant lookup

  -- 5  the community row: lifecycle gate, counter and version in one statement
  UPDATE communities
     SET member_count = member_count + 1,
         membership_version = membership_version + 1,
         updated_at = greatest(updated_at, $at)
   WHERE id = $c AND status = ANY($accepting)      -- from LifecycleEffects: {OPEN}
  RETURNING membership_version;
     0 rows  -> ROLLBACK -> locked         (412 communities.community_locked)

  -- 6  the new stint
  INSERT INTO community_members (id, community_id, user_id, status, standing, source,
                                 added_by, invitation_id, joined_at, version)
       VALUES ($s, $c, $u, 'ACTIVE', 'MEMBER', 'INVITATION', NULL, $l, $at, $v);
COMMIT -> joined (201); then audit communities.member.joined, then communities.member.added
```

The plain `INSERT` relies on the partial unique index as a backstop: under the
pair lock it cannot conflict, and if it ever did the transaction would abort
rather than leave `member_count` wrong. Every refusal rolls back, so a refused
redemption never consumes a use.

**Idempotent re-join.** An ACTIVE member redeeming any link of the same
community gets 200 and the community, with no use consumed, no audit entry and
no event.

### 7.4 Race semantics

Postgres re-evaluates a conditional `UPDATE`'s `WHERE` clause on the newest row
version after waiting for a concurrent writer. Every race below follows from
that and from the lock order.

| Race | Outcome |
| --- | --- |
| **Max uses**: 50 users, 1 use left | All queue on the invitation row. The first commits `uses = max_uses`; every later `UPDATE` re-evaluates `uses < max_uses` as false and rolls back: 412 `communities.invitation_exhausted`. The CHECK is the backstop. Different users never contend on pair locks ([S3b](#13-sequences)) |
| **Revoke** during redemption | Both write the invitation row. Revoke first: the redeem's `WHERE revoked_at IS NULL` is false → 412 `communities.invitation_revoked`, nothing consumed. Redeem first: U stays a member; revocation stops future use only, and removing U is a separate audited act |
| **Expiry** during redemption | `expires_at > $at` uses the clock instant taken at the start of the use case: the request either joins or gets 412 `communities.invitation_expired`, never both |
| **Lock** during redemption | Both write the community row. Lock first: the redeem's `status = ANY($accepting)` is false → 412 `communities.community_locked`; the tentative use rolls back. Redeem first: U joined before the lock. Never a stint created after the lock committed ([S5](#13-sequences)) |
| **Creator lost authority** | Checked at redemption, fail closed ([Q48](open-questions.md#q48--invitation-links)): the creator's ceiling before the transaction, standing under lock. The link fails as 404 `communities.invitation_invalid`, so the holder learns nothing about a third person's standing. A removal of the creator serializes on the creator's stint. The ceiling and owner checks ship in P2, where only owners create links: a demoted or suspended owner's links stop admitting at once. Only the grant lookup waits for P3, which adds the grant basis |
| **Double click** (same user twice) | The second request waits on the pair lock, then finds an ACTIVE stint: 200, no use consumed, no audit, no event |
| **Remove** racing redeem, same user | Pair lock. Removal first: the redeem sees REMOVED → 403 `communities.rejoin_requires_manager`. Redeem first: U joins, then is removed |

### 7.5 Brute force and enumeration

| Threat | Resistance |
| --- | --- |
| Guessing a token | 2²⁵⁶ search space. The shape is checked before hashing; an unknown token costs one indexed lookup |
| Load from guessing | Per-user limit, 10 attempts per 10 minutes, primary; per-IP limit, 300 per minute, generous so a school behind one NAT is not throttled; both development-safe PROVISIONAL defaults ([Q48](open-questions.md#q48--invitation-links), [Q26](open-questions.md#q26--realtime-limits)); 429 `communities.too_many_attempts` |
| Learning whether a token exists vs. is malformed | A malformed and an unknown token answer the same 404 `communities.invitation_invalid` |
| Enumerating communities | Ids are uuid v4; `join` takes no id; non-members get 404 identical to a missing community; invitation routes are nested under the community and authorized before the invitation is loaded |
| Stolen database | Hashes of 256-bit tokens cannot be reversed or replayed |

Rate limits are per process until a Redis limiter exists
(`shared/rate-limit.ts:4-8`); correctness does not depend on them.

### 7.6 A link never creates an account

`POST /communities/join` requires a signed-in account holding
`communities.read` (`@RequirePermission`, plus the one seam
`mayJoinByInvitation(principal)`, PROVISIONALLY "holds `communities.read`",
[Q48](open-questions.md#q48--invitation-links)). It is never a public route: the
public route set in `authorization.spec.ts:116-137` stays unchanged, and there
is no account-creation path, so the no-self-registration rule of
[Q2](open-questions.md#q2--who-is-the-first-owner-and-how-are-accounts-created-after-that)
holds. There is no preview endpoint (Q48). Guardians cannot join while PARENT
is inactive ([Q41](open-questions.md#q41--what-is-a-community-and-who-may-create-one)).

---

## 8. Lifecycle: OPEN and LOCKED

### 8.1 States

```
   OPEN ──lock──▶ LOCKED
   OPEN ◀─unlock── LOCKED          lock on LOCKED, unlock on OPEN: 'unchanged'
```

Two states only. **ARCHIVED was evaluated and deferred**
([Q47](open-questions.md#q47--retiring-a-community)): its meaning — who may
archive, whether it can be undone, what stays readable — is policy, as it was
for academic structure (Q32). Adding it later is one vocabulary value, one
CHECK migration and one row in each table below; consumers do not change,
because they read effects, not statuses. A community is never deleted.

### 8.2 What "locked" means — PROVISIONAL

The brief's six questions, answered provisionally by one Communities-owned table
([Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock)):

| Question | While LOCKED (provisional) | Enforced by | `CommunityHead.effects` |
| --- | --- | --- | --- |
| Can new members join? | **No, by any path** | `statePermits(members.invite)` → 412; `status = ANY($accepting)` in every join transaction | `acceptsMembers: false` |
| Can invitation links be used? | **Suspended**: neither consumed nor revoked; no new links; they work again after unlock unless expired or revoked | the same conditional `UPDATE`; the tentative use rolls back | `acceptsMembers: false` |
| Can messages be sent? | **No posting**, by anyone; reading continues | `statePermits(chat.post)`; Messaging asks per send ([community-chat.md](community-chat.md)) | `chatPostingOpen: false`, `chatReadable: true` |
| Can a new live session start? | **No** | `statePermits(live.start)` | `liveStartOpen: false` |
| Can an existing live session continue? | **Yes**: join, rejoin, raise hand, hosting and moderation continue | `live.join`, `live.raise_hand`, `live.moderate` allowed; `live.host` and `live.remain` while `runningLiveContinues` ([live.md](live.md)) | `liveJoinOpen: true`, `runningLiveContinues: true` |
| Can managers still manage? | **Yes**: unlock, view members, list and revoke links, remove members. No adding, no new links | `view`, `members.view`, `members.remove`, `lock` and the link-management override allowed | — |

Who may lock: the owner, a holder of a delegated `community.lock`, or a
`communities.manage` holder. **The gate never blocks `community.lock`**, so a
locked community can always be unlocked. Automatically revoking links on lock
was rejected: it is irreversible and destroys state the institution may want
back.

### 8.3 `statePermits` and `CommunityHead.effects`

One pure file, `communities/domain/lifecycle.ts`, holds both views of the same
table. `statePermits(status, act)` is used inside `COMMUNITY_AUTHORIZATION`;
`LifecycleEffects` is what principal-less consumers see through
`COMMUNITY_MEMBERSHIP.heads()`. **No other module ever sees the raw status.**

| Act | OPEN | LOCKED | unmapped status |
| --- | --- | --- | --- |
| `view`, `members.view`, `members.remove`, `lock` | yes | yes | yes (management stays open) |
| list or revoke links (the operation override of [§6.6](#66-which-act-each-communities-operation-asks)) | yes | yes | yes (management) |
| `members.invite` (add members, create a link), `chat.post`, `live.start` | yes | no | no |
| `chat.read`, `live.join`, `live.raise_hand` | yes | yes | no |
| `live.moderate` | yes | yes | yes (nobody is ejected) |
| `live.host`, `live.remain` | yes | yes | yes (`runningLiveContinues`) |

| Status | `acceptsMembers` | `chatReadable` | `chatPostingOpen` | `liveStartOpen` | `liveJoinOpen` | `runningLiveContinues` |
| --- | --- | --- | --- | --- | --- | --- |
| OPEN | T | T | T | T | T | T |
| LOCKED | F | T | F | F | T | T |
| unmapped | F | F | F | F | F | **T** — never eject on ignorance |

An unmapped status (for example a value added by a future migration that an
older build reads) closes every new action, keeps management open, and ejects
nobody from a running session. A test pins both tables; changing lock
semantics edits that test and Q46 together.

### 8.4 Lock concurrency and idempotency

Lock and unlock set an **absolute** state, so they need no expected version:

```
UPDATE communities
   SET status = $to, lifecycle_version = lifecycle_version + 1,
       status_changed_at = $at, status_changed_by = $actor,
       updated_at = greatest(updated_at, $at)
 WHERE id = $c AND status = $from
RETURNING lifecycle_version;
   1 row  -> changed: audit, then communities.community.locked | unlocked
   0 rows -> re-read: already $to -> 200 'unchanged', no audit, no event
                      missing     -> 404
```

- **Concurrent locks**: exactly one `UPDATE` matches. Ten simultaneous locks
  give `lifecycle_version + 1`, one audit entry, one event, and ten 200s.
- **Lock racing unlock**: serialized on the community row; the last commit
  wins. Each real change is audited with its own version, and consumers keep
  the highest `lifecycleVersion`.
- **Lock racing joins and adds**: [§7.4](#74-race-semantics) and S5.
- **Lock racing a chat send**: Messaging reads `statePermits` through the
  permit before taking its own conversation-row lock, so a send whose check
  preceded the lock commit may still be accepted — a window of milliseconds.
  There is no cross-module transaction, by design ([community-chat.md](community-chat.md)).
- **Lock during a live session**: the session continues; only new sessions
  are refused ([live.md](live.md)).

---

## 9. Membership at 30,000 and beyond

**30,000 members is not 30,000 live participants.** Membership is a database
scale; live participation is a media scale; online presence is a connection
scale. They are designed separately:

| Scale | Owner | What bounds it |
| --- | --- | --- |
| Membership (30,000+, no ceiling) | Communities | indexes, keyset pages, a maintained counter |
| Live participants in one session | Live | a LiveKit room is single-node; the published figure of about 3,000 per room must be benchmarked; capacity is deployment configuration taken from measurement ([live.md](live.md), [Q57](open-questions.md#q57--live-session-size-and-concurrency)). LiveKit's documentation site could not be read from here; those facts come from the SDK and server source |
| Online app connections | Realtime | one instance holds 10,000 connections (`realtime-policy.ts:42`) |

Nothing sizes a live room from membership: `COMMUNITY_MEMBERSHIP` exposes **no
member count and no "load all"**, and Live authorizes a join with one point
lookup. More simultaneous listeners than one room holds would be a separate
large-event capability inside Live
([Q58](open-questions.md#q58--more-listeners-than-one-room-can-hold)) and does
not touch this module.

**Every membership access is one of four shapes**, and no code path loads a
whole community:

| Shape | Operations | Cost |
| --- | --- | --- |
| Point lookup | `authorize`, `authorizeEach` (≤ 1,000), `statesOf` (≤ 1,000), `permittedAmong` (≤ 1,000, P6) | two unique-index probes per id, whatever the size (`permittedAmong` adds one `withPermission` call per ceiling permission) |
| Keyset page | roster (≤ 200), `members()` (≤ 1,000), holders (≤ 1,000), my communities | O(page), on partial indexes that hold only ACTIVE rows, so churn history never slows them |
| Counter | `memberCount` in HTTP views | O(1) |
| Ordered feed | `changesSince` on `UNIQUE (community_id, version)` | one statement per page |

**Hot rows.** Every new join updates the invitation row and the community row
in one short transaction, so joins into **one** community serialize at about
one commit latency each; joins into different communities never contend, and
idempotent re-joins lock neither row. The per-community serialization is what
gives `changesSince` its commit order. Throughput is **measured, not
promised**: load profile 4 (P8) runs a 30,000-account join storm through one
link on the target topology. If it proves too slow, the remedy is inside the
adapter and must keep the contract's guarantee — versions unique and in commit
order. Manager adds are capped at 200 per request to keep the row lock short.

**Waiting must not hold pool connections.** The pool has 10 connections per
process with a 5 s acquire timeout (`platform/database/database.ts:28-30`); a
storm of redemptions queued on one invitation row, or of adds, leaves and
removals on one community row, would otherwise hold all ten and fail
unrelated routes (messaging reads, live joins, every consumer's `authorize`).
So every transaction that updates the community row first takes an
in-process async mutex keyed by the community id, before it checks out a
connection ([§4](#the-global-lock-order)), as Live does per session: the storm
queues in memory and holds at most one connection per community per process
(one API instance until P11). It pairs with the per-user and per-IP limits of
[§7.5](#75-brute-force-and-enumeration), and load profile 4 asserts that pool
wait and the p95 of an unrelated request mix stay bounded during the storm.

**Roster visibility — the Q22 question for communities.** Publishing a
30,000-member roster of minors to every member is a privacy decision
([Q22](open-questions.md#q22--who-may-see-who-is-in-a-conversation), which also
covers community rosters). PROVISIONAL default: members see the community, its
member count and themselves; listing members requires `community.members.view`
(the owner, a grant, or `communities.manage`); the list shows display names
only, never emails; `source` and `addedBy` are not exposed. Messaging refuses
to list a community chat's participants (`messaging.members_hidden`), so the
roster cannot leak through the chat. Live sessions are the exception: under
Q59's PROVISIONAL default every participant sees the names of everyone in the
room, so a member sees part of the roster by joining a session
([Q59](open-questions.md#q59--visibility-inside-a-live-session)).

**Multiple instances.** Every invariant is enforced by the database, so a
second API instance changes no correctness property. The in-process event bus
and rate limiter are existing single-instance limits, replaced behind their
ports in P11.

---

## 10. Public contracts

`CommunitiesModule` imports `IdentityModule` only and exports **only contract
tokens**. `communities/contracts/*` imports only `src/shared` (`Result`,
`Principal`) and `identity/contracts/permissions.ts` — never the identity
barrel, which re-exports route-access decorators.

### `capabilities.ts`

```ts
export const COMMUNITY_RESOURCE = 'communities.community';

export const COMMUNITY_CAPABILITIES = ['community.members.view', 'community.members.invite',
  'community.members.remove', 'community.lock', 'community.chat.post',
  'community.live.start', 'community.live.moderate'] as const;
// Reserved and added in P9 with a CHECK migration: 'community.attendance.record', 'community.attendance.view'.
// Reserved until Q51/Q23: 'community.messages.moderate'.
export type CommunityCapability = (typeof COMMUNITY_CAPABILITIES)[number];

export const COMMUNITY_PARTICIPATION = ['community.view', 'community.chat.read',
  'community.live.join', 'community.live.raise_hand'] as const;

/** community.live.host: backed by community.live.start, the session host's moderation of their own session.
 *  community.live.remain (P6): staying in a running session; the ceiling and basis of community.live.join,
 *  allowed while runningLiveContinues instead of liveJoinOpen. */
export const COMMUNITY_DERIVED_ACTS = ['community.live.host', 'community.live.remain'] as const;

export type CommunityAct = CommunityCapability
  | (typeof COMMUNITY_PARTICIPATION)[number] | (typeof COMMUNITY_DERIVED_ACTS)[number];
export function isCommunityCapability(v: string): v is CommunityCapability;
export function isCommunityAct(v: string): v is CommunityAct;

/** P4. The identity permissions of the community.chat.read ceiling (PROVISIONAL, §6.4). The act rules use it,
 *  and Messaging narrows every community-chat page of MESSAGE_RECIPIENTS with it, one
 *  ACCOUNT_DIRECTORY.withPermission call per permission, so the two paths cannot drift. */
export const COMMUNITY_CHAT_READ_CEILING: readonly Permission[] = ['communities.read', 'messaging.read'];
```

`COMMUNITY_CHAT_READ_CEILING` is the one addition to Communities' contracts
that the community chat (P4) needs
([community-chat.md §12.6](community-chat.md#126-what-communities-provides)):
with it, each community-chat recipient page costs two `withPermission` calls
([community-chat.md §7.3](community-chat.md#73-who-receives-a-message-the-lag-filter)).
The rest of P4 is Messaging's own: the projection's three `source_*` columns
(`source_version`, `source_membership_id`, which decides rejoins, and
`source_joined_at`) under the shape CHECK
`conversation_participants_source_shape`
([community-chat.md §6.1](community-chat.md#61-shape-and-invariants)), and the
capacity switch `communityChatMaxServedMembers`, above which a send answers
412 `messaging.community_chat_over_capacity` and `canPost` is false
([community-chat.md §7.2](community-chat.md#72-may-this-principal-send)).

### `COMMUNITY_AUTHORIZATION` (`authorization.ts`)

```ts
export const COMMUNITY_AUTHORIZATION = Symbol('COMMUNITY_AUTHORIZATION');
export const MAX_AUTHORIZE_BATCH = 1000;
export type CommunityAuthorityBasis = 'membership' | 'owner' | 'grant' | 'oversight';
export interface CommunityPermit {
  readonly principalUserId: string;
  readonly communityId: string;
  readonly scope: typeof COMMUNITY_RESOURCE;
  readonly act: CommunityAct;
  readonly basis: CommunityAuthorityBasis;
  readonly membership: { readonly membershipId: string; readonly joinedAt: Date;
                         readonly version: number } | null; // null iff basis === 'oversight'
  readonly grantId: string | null;                          // non-null iff basis === 'grant'
  readonly ceiling: readonly Permission[];  // identity permissions required and held on the path taken
}
export interface CommunityAuthorization {
  authorize(principal: Principal, communityId: string, act: CommunityAct): Promise<Result<CommunityPermit>>;
  /** At most MAX_AUTHORIZE_BATCH ids (RangeError above), O(1) statements. Unknown ids -> not_found. */
  authorizeEach(principal: Principal, communityIds: readonly string[], act: CommunityAct):
    Promise<ReadonlyMap<string, Result<CommunityPermit>>>;
  /** P6. Trusted in-process, no principal, never the oversight basis: of userIds (<= MAX_AUTHORIZE_BATCH,
   *  RangeError above), those the act's ceiling (ACCOUNT_DIRECTORY.withPermission), owner, grant or
   *  membership basis and statePermits accept. For Live's reconciler and LIVE_AUDIENCE. */
  permittedAmong(communityId: string, userIds: readonly string[], act: CommunityAct): Promise<readonly string[]>;
}
```

Evaluation as in [§6.5](#65-the-evaluator); `permittedAmong` runs the same
`decideCommunityAct` per user, with the ceiling taken from `withPermission`
instead of a Principal, so consumers keep no copy of the act rules. A store
failure rejects the promise; callers fail closed with 503. `membership` lets
Messaging repair its projection on access; `version` orders that repair.

### `COMMUNITY_MEMBERSHIP` (`membership.ts`)

```ts
export const COMMUNITY_MEMBERSHIP = Symbol('COMMUNITY_MEMBERSHIP');
export const MAX_MEMBER_PAGE = 1000;

/** PROVISIONAL table owned by communities (Q46). Consumers never see the raw status. */
export interface LifecycleEffects { readonly acceptsMembers: boolean; readonly chatReadable: boolean;
  readonly chatPostingOpen: boolean; readonly liveStartOpen: boolean; readonly liveJoinOpen: boolean;
  readonly runningLiveContinues: boolean }

export interface CommunityHead { readonly communityId: string; readonly membershipVersion: number;
  readonly lifecycleVersion: number; readonly effects: LifecycleEffects }

export interface MemberState {
  readonly communityId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly active: boolean;
  readonly joinedAt: Date;  // this stint's start; a rejoin is a new stint
  readonly version: number; // > 0, unique per community, commit order
}

export interface MembershipChanges {
  readonly states: readonly MemberState[]; // ascending version, latest per user
  readonly head: CommunityHead;            // same snapshot
  readonly throughVersion: number;
  readonly hasMore: boolean;
}

export interface CommunityMembership {
  heads(communityIds: readonly string[]): Promise<readonly CommunityHead[]>; // <= 1000; unknown ids absent
  listHeads(page: { readonly afterCommunityId?: string; readonly limit: number }):
    Promise<{ readonly items: readonly CommunityHead[]; readonly next: string | null }>;
  statesOf(communityId: string, userIds: readonly string[]): Promise<readonly MemberState[]>;
    // <= 1000; latest stint per user; never-members absent
  changesSince(communityId: string, afterVersion: number, limit: number):
    Promise<MembershipChanges | null>; // ONE statement; null = unknown community
  members(communityId: string, page: { readonly onlyUserIds?: readonly string[];
    readonly excludeUserId?: string; readonly cursor?: string | null; readonly limit: number }):
    Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>;
    // current ACTIVE members in user-id order; RangeError on a bad cursor, limit or list
}
```

Trusted in-process, with no principal — the `MESSAGE_RECIPIENTS` stance. It
answers facts, never access: a consumer that acts for a person asks
`COMMUNITY_AUTHORIZATION`.

### `COMMUNITY_DIRECTORY` (`directory.ts`)

```ts
export const COMMUNITY_DIRECTORY = Symbol('COMMUNITY_DIRECTORY');
export interface CommunitySummary { readonly communityId: string; readonly title: string }
export interface CommunityDirectory {
  describe(communityIds: readonly string[] /* <= 1000 */): Promise<readonly CommunitySummary[]>;
} // display only; never an access answer; unknown ids absent
```

Messaging resolves a community chat's title through it when the chat is
viewed, after a positive permit; the stored conversation title is null.

### `COMMUNITY_CAPABILITY_HOLDERS` (`capability-holders.ts`, P3)

```ts
export const COMMUNITY_CAPABILITY_HOLDERS = Symbol('COMMUNITY_CAPABILITY_HOLDERS');
export const MAX_HOLDER_PAGE = 1000;
export interface CommunityCapabilityHolders {
  list(communityId: string, capability: CommunityCapability,
       page: { readonly cursor?: string | null; readonly limit: number }):
    Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>;
}
```

The owner (implicit) plus ACTIVE grants on ACTIVE stints, filtered by the
capability's standing ceiling through `ACCOUNT_DIRECTORY.withPermission`, so
dormant holders are excluded. Keyset-paged by user id; a page may be short
after filtering, and callers loop until `nextCursor` is null. Never includes
overseers. Trusted in-process, no principal.

### `vocabulary.ts` and `events.ts`

`COMMUNITY_STATUSES ['OPEN','LOCKED']`; `MEMBERSHIP_STATUSES
['ACTIVE','LEFT','REMOVED']`; `MEMBERSHIP_STANDINGS ['OWNER','MEMBER']`;
`MEMBERSHIP_SOURCES ['ADDED','INVITATION']`; `INVITATION_STATES
['ACTIVE','EXPIRED','EXHAUSTED','REVOKED']` (derived); type guards. Events in
[§11](#11-events-and-audit).

### Consumers

| Consumer | Uses |
| --- | --- |
| Messaging (P4, application layer only) | `COMMUNITY_AUTHORIZATION` (`chat.read`, `chat.post`); `COMMUNITY_MEMBERSHIP` (`heads`, `listHeads`, `statesOf`, `changesSince`, `members`); `COMMUNITY_DIRECTORY`; `COMMUNITY_CHAT_READ_CEILING`; `member.*` events as wake-ups |
| Live (P6) | `COMMUNITY_AUTHORIZATION` (`live.start`, `live.host`, `live.moderate`, `live.join`, `live.raise_hand` per request; `permittedAmong` for `live.join`, `live.remain`, `live.moderate` and `live.host` in batches of 1,000 for the reconciler and `LIVE_AUDIENCE`); `COMMUNITY_MEMBERSHIP` (`heads` for session-wide effects); `COMMUNITY_CAPABILITY_HOLDERS` (moderators); `member.removed`, `capability.revoked`, `community.locked/unlocked` as accelerators |
| Realtime (P5) | `COMMUNITY_MEMBERSHIP.members` (OnlineAudience); `CommunityEvents` |
| Attendance (P9, HELD) | `COMMUNITY_AUTHORIZATION` (the attendance acts, then the fallbacks `live.moderate`, `live.host` and `view` of [§6.12](#612-how-live-messaging-and-attendance-ask)) |
| Notifications (P10, after Q67/Q28) | `COMMUNITY_MEMBERSHIP` or `COMMUNITY_CAPABILITY_HOLDERS` for recipients |

**What Communities must not know**: conversations, chat data (no last message
or unread count in its API), live sessions ("live now" is composed by the
client from `GET /live/communities/:communityId/sessions/current`; a field here
would need Communities → Live and close a cycle), LiveKit, attendance, realtime,
notifications, academic and halaqat, and any other module's tables.

---

## 11. Events and audit

Names and payload types live in `communities/contracts/events.ts`.
`aggregateId` is always `communityId`, so one community's changes form one
ordered stream. Payloads carry **ids, codes and versions only** — never a
title, a name, a token, a token hash, an expiry or a use limit. Every mutating
use case goes through `CommunitiesJournal`: audit, then event, after commit,
and nothing for a no-op or an idempotent repeat. Durability classes are
[ADR 0021](decisions/0021-cross-cutting-rules-for-new-modules.md)'s:
**R** (loss tolerable; the table is the fact) and **S** (a security reaction
with a reconciler backstop).

| Event | Payload | Class | Consumers | Travels |
| --- | --- | --- | --- | --- |
| `communities.community.created` | `{communityId, createdBy: string \| null}` | R | none in v1; always followed by `member.added` for the owner | in-process only |
| `communities.community.locked` / `.unlocked` | `{communityId, lockedBy \| unlockedBy: string \| null, lifecycleVersion}` | R | realtime relay; Live `ProtectLiveSessions` (accelerator). No consumer enforces the lock from the event: decisions pull the permit | frame `community.locked`/`unlocked` `{communityId, lifecycleVersion}` to ACTIVE members online (P5) |
| `communities.member.added` | `{communityId, userId, membershipId, source: 'ADDED' \| 'INVITATION', addedBy, invitationId, membershipVersion}` | R | Messaging `CommunityChatSync` (wake-up); realtime relay | frame to that user only |
| `communities.member.removed` | `{communityId, userId, membershipId, reason: 'LEFT' \| 'REMOVED', removedBy, membershipVersion}` — implies every grant of that stint ended in the same transaction | **S** | Live (ejection; backstop: the 60 s participant sweep); Messaging (wake-up; access is already refused at commit); realtime relay | frame to that user only |
| `communities.invitation.created` / `.revoked` | `{communityId, invitationId, createdBy \| revokedBy: string \| null}` | R | none; revocation takes effect inside redemption, not through delivery | never on any wire |
| `communities.capability.granted` / `.revoked` (P3) | `{communityId, grantId, membershipId, userId, capability, grantedBy \| revokedBy}`; `revoked` only for owner revocations | R | realtime relay; Live re-evaluates an affected holder in a running session | `community.access.changed {communityId}` to that user only |
| `communities.ownership.transferred` (P3) | `{communityId, fromUserId, toUserId, transferredBy, basis: 'owner' \| 'oversight', endedGrantIds: string[] (at most one per delegable capability: 7 in P3, 9 after P9)}` | R | realtime relay | `community.access.changed` to `fromUserId` and `toUserId` only |

`endedGrantIds` holds at most one id per delegable capability, because a stint
has at most one ACTIVE grant per capability: seven in P3, nine after P9.
Frames are realtime's
([communities-live-attendance.md](communities-live-attendance.md)); a frame is
a refresh hint, never a grant.

**Audit.** One entry per effective change, resource
`communities.community/<communityId>`, with `metadata.authority =
{act, basis, membershipId, grantId}` where a permit authorized it:

| Action | When |
| --- | --- |
| `communities.community.created` | a community is created |
| `communities.community.locked` / `.unlocked` | a real status change (brief §26) |
| `communities.member.added` | a manager add, one per newcomer |
| `communities.member.joined` | a link redemption; actor is the joiner; metadata `{invitationId}` |
| `communities.member.removed` / `.left` | a removal (brief §26) / a leave |
| `communities.invitation.created` / `.revoked` | metadata `{invitationId, expiresAt, maxUses}` / `{invitationId}` (brief §26) |
| `communities.capability.granted` / `.revoked` (P3) | per grant row; delegated permission changes (brief §26) |
| `communities.ownership.transferred` (P3) | metadata `{fromUserId, toUserId, basis, endedGrantIds}` |
| `communities.oversight.read` (name proposed here) | a read on the oversight basis, metadata `{act}` — PROVISIONAL ([Q43](open-questions.md#q43--institutional-oversight-of-communities)) |

Never audited: member reads, evaluations, denials, failed redemptions,
no-ops and idempotent repeats — those are logs and metrics. Never recorded
anywhere: the token or its hash (tests serialize audit entries, events and log
output and search for both). Grant rows keep `granted_by/at` and
`ended_by/at/reason`, which covers the known gap where the audit write after
commit fails.

---

## 12. API

Every route needs a bearer token (401 otherwise) and declares its permission.
The edge permission is `communities.read` for every route except creation
(`communities.create`) and grant/revoke (`communities.moderate`); an
architecture test maps each route to exactly that. Every use case authorizes
again with resource context, because jobs and handlers bypass guards
(`identity/contracts/authorization.ts:28-31`). Controllers validate DTOs and
unwrap Results; no business logic.

| Route | Act (§6.6) | Success | Errors |
| --- | --- | --- | --- |
| `GET /communities?scope=mine\|all&cursor&limit` | mine: own stints; all: `communities.manage` | 200 `{items: CommunityResponse[], nextCursor}`; mine newest join first, all newest first; default 30, max 100 | 403 `identity.permission_denied` (all), 422 `communities.cursor_invalid` |
| `POST /communities {title}` | `communities.create` | 201 `CommunityResponse` (not idempotent, like messaging's group creation) | 422 `communities.title_invalid`, 429 `communities.too_many_communities` |
| `GET /communities/:communityId` | `view` | 200 `CommunityResponse` | 404 |
| `POST /communities/:communityId/lock` · `/unlock` | `lock` | 200 `CommunityResponse` (idempotent) | 403, 404 |
| `GET /communities/:communityId/members?cursor&limit` | `members.view` | 200 `{items: [{userId, displayName, active, joinedAt}], nextCursor}`; default 50, max 200 | 403 `communities.capability_required`, 404 |
| `POST /communities/:communityId/members {userIds[1..200]}` | `members.invite` | 201 `{added, unchanged}` when anyone was added, 200 when nobody was | 412 `communities.community_locked`, 422 `communities.members_not_eligible {userIds}`, 429 |
| `DELETE /communities/:communityId/members/:userId` | `members.remove` (+ R6) | 204 | 404 `communities.member_not_found`, 412 `communities.owner_not_removable`, 403 |
| `POST /communities/:communityId/leave` | `view` | 204 | 412 `communities.owner_cannot_leave`, 404 |
| `POST /communities/:communityId/invitations {expiresInSeconds?, maxUses?}` | `members.invite` | 201 `{invitation: InvitationResponse, token}` — the only response that ever holds the token | 412 `communities.community_locked`, 422 `communities.invitation_terms_invalid {field}`, 429 |
| `GET /communities/:communityId/invitations?cursor&limit` | `members.invite`, or oversight | 200 `{items: InvitationResponse[], nextCursor}` | 403, 404 |
| `POST /communities/:communityId/invitations/:invitationId/revoke` | `members.invite`, or oversight | 200 `InvitationResponse` (idempotent) | 404 `communities.invitation_not_found` |
| `POST /communities/join {token}` | `communities.read` + `mayJoinByInvitation` | 201 `CommunityResponse` when joined, 200 when already a member | 404 `communities.invitation_invalid`; 412 `communities.invitation_revoked` / `_expired` / `_exhausted` / `community_locked`; 403 `communities.rejoin_requires_manager`; 429 `communities.too_many_attempts` |
| `GET /communities/:communityId/grants?userId&capability&cursor&limit` (P3) | owner: all; holder: own | 200 `{items: [{grantId, userId, capability, grantedAt, grantedBy, dormant}], nextCursor}` | 404 |
| `POST /communities/:communityId/grants {userId, capabilities[1..7]}` (P3) | owner (R1–R3) | 201 `{created, unchanged}` | 403 `communities.not_community_owner`, 403 `identity.permission_denied`, 422 `communities.grantee_ineligible`, 404 |
| `DELETE /communities/:communityId/grants/:grantId` (P3) | owner | 204 (idempotent) | 404 `communities.grant_not_found` |
| `PUT /communities/:communityId/owner {userId}` (P3) | owner, or `communities.manage` | 200 `CommunityResponse` | 409 `communities.owner_conflict`, 422 `communities.owner_ineligible`, 403 `communities.owner_self_assignment` |

`communities.not_community_owner` follows the Community naming rule
([§1](#1-terminology)); an earlier draft of this design spelled it
`not_group_owner`. `communities.grant_not_found` is named here. Any route
may also answer 409 `communities.conflict` (a deadlock victim after one retry)
and 503 `unavailable` (a store or directory failure, once P0 adds the kind).

```
CommunityResponse {
  id, title, status: 'OPEN' | 'LOCKED', lifecycleVersion, memberCount, createdAt,
  me: {
    standing: 'OWNER' | 'MEMBER' | null,   // null on the oversight basis
    joinedAt: string | null,
    capabilities: CommunityCapability[],   // effective now: ceiling AND standing AND gate
    participation: (typeof COMMUNITY_PARTICIPATION)[number][]
  }
}
InvitationResponse { id, createdBy, createdAt, expiresAt, maxUses, uses, state, revokedAt }
```

`me` is a UI courtesy, computed by the same evaluator (the Conversation
`canPost` precedent); the server never trusts it back. `state` is derived at
request time. The roster's `active` is the account's state from
`AccountDirectory`, not the membership's.

**DTO rules.** Unknown fields are refused (400). A value outside a vocabulary
(`scope`, a capability) is 400 at the DTO. `title` is trimmed, 1–100
characters, with no control or bidi-override characters (422 otherwise).
`userIds` and `capabilities` are non-empty and unique. `expiresInSeconds` is
300–2,592,000, default 604,800; `maxUses` is null or 1–2,147,483,647 (both
PROVISIONAL, [Q48](open-questions.md#q48--invitation-links)). `limit` is
clamped to its maximum; a forged cursor is 422 `communities.cursor_invalid`.
The token is accepted only as the body key `token`. No response contains an
email (the API test asserts no `@`), a token hash, or how or by whom someone
joined. Rate limits are development-safe PROVISIONAL defaults
(community creation 20 per hour; link creation 30 per hour; joins 10 per 10
minutes per user and 300 per minute per IP; adds and grants per user),
answering 429 with `retryAfterSeconds` ([Q48](open-questions.md#q48--invitation-links),
[Q26](open-questions.md#q26--realtime-limits)).

**The brief's candidate routes**, as placed here:

| Brief | Here |
| --- | --- |
| `GET /groups`, `GET /groups/:id`, `GET /groups/:id/members` | `GET /communities`, `GET /communities/:communityId`, `…/members` |
| `POST /groups/:id/invites` | `POST /communities/:communityId/invitations` |
| `POST /groups/:id/join` | `POST /communities/join {token}` — no id in the path |
| `POST /groups/:id/lock`, `/unlock` | `POST /communities/:communityId/lock`, `/unlock` |
| `POST /groups/:id/live/sessions` and below | Live's routes, prefixed by the module that owns them: `/live/communities/:communityId/sessions`, `/live/sessions/:sessionId/…` ([live.md](live.md)) |
| `…/attendance` | `/attendance/…` ([attendance.md](attendance.md)) |

**Flutter.** An abstract `CommunityRepository` with HTTP and mock
implementations bound only in `app_providers.dart`; wire enums with an
`unknown` member; buttons shown from `me.capabilities` only, never from roles;
an `/invite` route that reads the token from the link, holds it in memory,
POSTs it once and never stores or logs it. Details in the hub.

---

## 13. Sequences

`P` principal, `C` community, `U` redeemer, `L` invitation, `K` link creator,
`O` owner, `T` grantee, `M` manager. `Authz` is `COMMUNITY_AUTHORIZATION`,
`Store` the Postgres repository, `Journal` `CommunitiesJournal` (audit, then
event bus).

### S1 — Create a community (P2)

```
 App           API           UseCase       Identity      Store         Journal
 |             |             |             |             |             |
 | 1 POST /communities {title}             |             |             |
 |------------>|             |             |             |             |
 |             | 2 guard: can(P, communities.create)     |             |
 |             | 3 execute(P, title)       |             |             |
 |             |------------>|             |             |             |
 |             |             | 4 authorize(P, communities.create)      |
 |             |             |------------>|             |             |
 |             |             | 5 person principal? rate limit;         |
 |             |             |   newCommunity(title)     |             |
 |             |             | 6 create(community, owner)|             |
 |             |             |-------------------------->|             |
 |             |             |             |             | 7 one transaction (below)
 |             |             | 8 created   |             |             |
 |             |             |<--------------------------|             |
 |             |             | 9 audit, then 2 events    |             |
 |             |             |---------------------------------------->|
 | 10 201 CommunityResponse  |             |             |             |
 |<------------|             |             |             |             |
```

- 4: re-authorized in the use case, because jobs bypass guards.
- 5: a system principal is refused (it cannot hold a stint); 429
  `communities.too_many_communities`; 422 `communities.title_invalid`. The
  creator holds `communities.moderate` by the `role.spec` invariant.
- 7: `BEGIN; INSERT communities (status 'OPEN', lifecycle_version 1,
  membership_version 1, member_count 1); INSERT community_members (ACTIVE,
  standing OWNER, source ADDED, added_by P, version 1); COMMIT`.
- 9: audit `communities.community.created`; events
  `communities.community.created` then `communities.member.added` (the owner).
- 10: `me.standing` OWNER; `me.capabilities` every capability whose ceiling P
  holds.

### S2 — Create an invitation link (P2)

```
 App           API           UseCase       Authz         Secrets       Store         Journal
 |             |             |             |             |             |             |
 | 1 POST /communities/C/invitations       |             |             |             |
 |------------>|             |             |             |             |             |
 |             | 2 guard: can(P, communities.read)       |             |             |
 |             | 3 execute   |             |             |             |             |
 |             |------------>|             |             |             |             |
 |             |             | 4 authorize(P, C, members.invite)       |             |
 |             |             |------------>|             |             |             |
 |             |             |             | 5 ceiling, read, basis, gate            |
 |             |             | 6 ok(permit)|             |             |             |
 |             |             |<------------|             |             |             |
 |             |             | 7 rate limit; validate terms            |             |
 |             |             | 8 issue()   |             |             |             |
 |             |             |-------------------------->|             |             |
 |             |             | 9 {token, tokenHash}      |             |             |
 |             |             |<--------------------------|             |             |
 |             |             | 10 createInvitation(tokenHash, terms, permit)         |
 |             |             |---------------------------------------->|             |
 |             |             |             |             |             | 11 re-verify basis
 |             |             |             |             |             |    under lock; INSERT
 |             |             | 12 created or token_collision or basis_lost           |
 |             |             |<----------------------------------------|             |
 |             |             | 13 audit, then invitation.created       |             |
 |             |             |------------------------------------------------------>|
 | 14 201 {invitation, token}|             |             |             |             |
 |<------------|             |             |             |             |             |
```

- 5: [§6.5](#65-the-evaluator). Refusals: 403 `identity.permission_denied`, 404,
  403 `communities.capability_required`, 412 `communities.community_locked`
  (no new links while LOCKED). Oversight is not admitted.
- 7: 422 `communities.invitation_terms_invalid {field}`; 429.
- 11: `BEGIN; actor's ACTIVE stint FOR SHARE; (basis grant) the grant FOR SHARE;
  INSERT community_invitations; COMMIT`. `basis_lost` → the permit is
  re-evaluated and its refusal returned. `token_collision` → steps 8–12 once
  more.
- 13: the event carries `{communityId, invitationId, createdBy}` only.
- 14: the token exists only in this response and in the creator's hands.

<a id="s3--redeem-a-link-p2-step-7-in-p3"></a>

### S3 — Redeem a link (P2)

```
 App           API           UseCase       Identity      Store         Journal
 |             |             |             |             |             |
 | 1 POST /communities/join {token}        |             |             |
 |------------>|             |             |             |             |
 |             | 2 per-IP limit; guard: communities.read |             |
 |             | 3 execute(P, token)       |             |             |
 |             |------------>|             |             |             |
 |             |             | 4 per-user limit; token shape;          |
 |             |             |   h := sha256(token)      |             |
 |             |             | 5 lookup(h) |             |             |
 |             |             |-------------------------->|             |
 |             |             | 6 {L, C, createdBy K} or none           |
 |             |             |<--------------------------|             |
 |             |             | 7 withPermission([K], moderate)         |
 |             |             |------------>|             |             |
 |             |             | 8 redeem(L, C, U, K, at)  |             |
 |             |             |-------------------------->|             |
 |             |             |             |             | 9 one transaction (below)
 |             |             | 10 outcome  |             |             |
 |             |             |<--------------------------|             |
 |             |             | 11 joined only: audit, event            |
 |             |             |---------------------------------------->|
 | 12 201, 200, 403, 404, 412 or 429       |             |             |
 |<------------|             |             |             |             |
```

- 4, 6, 7: a malformed token, an unknown one and a creator without the
  ceiling all answer 404 `communities.invitation_invalid`.
- 9: the transaction of [§7.3](#73-redemption).
- 10: `joined`, `already_member`, `removed`, `revoked`, `expired`,
  `exhausted`, `locked` or `creator_lost`.
- 11: audit `communities.member.joined`; event `communities.member.added
  {source INVITATION, invitationId L, membershipVersion v}`.

**S3b — the concurrent case: the last use, and a double click.** Invitation L
has `max_uses = 10`, `uses = 9`.

```
 T1: U1 redeems L               T2: U2 redeems L               T3: U1 again (double click)
 |                              |                              |
 1 pair lock (C,U1)             |                              |
 |                              2 pair lock (C,U2)             |
 |                              |                              3 pair lock (C,U1):
 |                              |                                WAITS for T1
 4 latest stint: none           |                              |
 5 UPDATE L SET uses = 10       |                              |
   (row L now locked by T1)     |                              |
 |                              6 latest stint: none           |
 |                              7 UPDATE L ...: WAITS for T1   |
 8 UPDATE C: count +1,          |                              |
   version v                    |                              |
 9 INSERT stint; COMMIT         |                              |
   -> 201; audit; event         |                              |
 |                              10 WHERE re-evaluated on       |
 |                                 new row: uses < max_uses    |
 |                                 is false -> 0 rows          |
 |                              11 ROLLBACK -> 412             |
 |                                 invitation_exhausted        |
 |                              |                              12 lock granted; latest
 |                              |                                 stint ACTIVE -> COMMIT
 |                              |                                 -> 200; no use consumed,
 |                              |                                 no audit, no event
```

Exactly one use is consumed, one stint created, one audit entry and one event
written; `member_count = count(ACTIVE)` throughout.

### S4 — Delegate a capability (P3)

```
 Owner app     API           UseCase       Identity      Store         Journal       Realtime
 |             |             |             |             |             |             |
 | 1 POST /communities/C/grants {userId T, capabilities} |             |             |
 |------------>|             |             |             |             |             |
 |             | 2 guard: can(O, communities.moderate)   |             |             |
 |             | 3 execute   |             |             |             |             |
 |             |------------>|             |             |             |             |
 |             |             | 4 can(O, p, ctx) per ceiling p          |             |
 |             |             |------------>|             |             |             |
 |             |             | 5 withPermission([T], p) per p          |             |
 |             |             |------------>|             |             |             |
 |             |             | 6 grant(O, T, capabilities)             |             |
 |             |             |-------------------------->|             |             |
 |             |             |             |             | 7 one transaction (below) |
 |             |             | 8 {created, unchanged}    |             |             |
 |             |             |<--------------------------|             |             |
 |             |             | 9 per created row: audit, event         |             |
 |             |             |---------------------------------------->|             |
 |             |             |             |             |             | 10 capability.granted
 |             |             |             |             |             |------------>|
 |             |             |             |             |             |             | 11 community.access.changed
 |             |             |             |             |             |             |    to T only (P5)
 | 12 201 {created, unchanged}             |             |             |             |
 |<------------|             |             |             |             |             |
```

Example: `capabilities: ['community.live.moderate', 'community.lock']`.

- 4: R2, no escalation, in memory with context
  `{communities.community, C, {act}}`: `communities.moderate`, `live.moderate`.
  A miss is 403 `identity.permission_denied` and nothing is read.
- 5: R3 — any miss is 422 `communities.grantee_ineligible`.
- 7: `BEGIN; SELECT id, user_id, standing FROM community_members WHERE
  community_id = C AND user_id IN (O, T) AND status = 'ACTIVE' ORDER BY id FOR
  SHARE;` O missing → 404; O not OWNER → 403 `communities.not_community_owner`;
  T missing or OWNER → 422 `communities.grantee_ineligible`; then `INSERT …
  ON CONFLICT (membership_id, capability) WHERE ended_at IS NULL DO NOTHING
  RETURNING id, capability; COMMIT`. The community row is never touched.
- 9: one audit entry `communities.capability.granted` and one event per
  **inserted** row; a repeated grant writes nothing.
- 11: T's app refetches `GET /communities/C`; nothing is broadcast.

### S5 — Lock while an invitation is being redeemed (P2)

**S5a — the lock reaches the community row first.**

```
 T1: M locks C                     T2: U redeems L into C
 |                                 |
 1 M's stint FOR SHARE             |
   (owner or grant basis)          |
 2 UPDATE communities              |
   SET status = LOCKED, ...        |
   WHERE id = C AND                |
   status = OPEN                   |
   -> 1 row; row C locked          |
 |                                 3 pair lock (C,U);
 |                                   latest stint: none
 |                                 4 UPDATE L SET uses+1 ...
 |                                   -> 1 row (tentative)
 |                                 5 creator's stint
 |                                   FOR SHARE
 |                                 6 UPDATE communities ...
 |                                   WHERE status = ANY(OPEN)
 |                                   -> WAITS for T1
 7 COMMIT; audit;                  |
   communities.community.locked    |
 |                                 8 WHERE re-evaluated on the
 |                                   new row: status LOCKED
 |                                   -> 0 rows
 |                                 9 ROLLBACK (uses+1 undone)
 |                                   -> 412 community_locked
```

**S5b — the redemption reaches the community row first.**

```
 T1: M locks C                     T2: U redeems L into C
 |                                 |
 |                                 1 pair lock; UPDATE L;
 |                                 2 UPDATE communities
 |                                   count +1, version v
 |                                   -> row C locked
 3 M's stint FOR SHARE;            |
   UPDATE communities              |
   WHERE status = OPEN             |
   -> WAITS for T2                 |
 |                                 4 INSERT stint; COMMIT
 |                                   -> 201: U joined before
 |                                   the lock
 5 -> 1 row; COMMIT;               |
   audit; event                    |
   (U stays a member)              |
```

In both orders: no stint is created after the lock commits, and a refused
redemption consumes no use. Both transactions follow the global lock order, so
no interleaving deadlocks; a `FOR SHARE` on M's stint and on the creator's
stint are compatible even when M is the creator.

---

## 14. Failure modes

| Case | Semantics |
| --- | --- |
| Duplicate join (double tap, retry, two devices) | The second waits on the pair lock, finds an ACTIVE stint: 200, no use, no audit, no event |
| Concurrent redemptions exceed `maxUses` | Exactly the remaining uses are admitted; the rest 412 `invitation_exhausted`; CHECK backstop |
| Link revoked while being redeemed | Serialized on the invitation row; whichever commits first wins ([§7.4](#74-race-semantics)) |
| Link expires during redemption | One clock instant per request: joins or 412 `invitation_expired`, never both |
| Link creator lost authority | 404 `invitation_invalid`, fail closed (Q48); the ceiling and owner checks from P2, the grant lookup from P3 |
| Community locked while joins or adds are in flight | Serialized on the community row; later joins roll back with 412 `community_locked`, consuming nothing |
| Two principals lock at once; lock racing unlock | One real change; the other 200 `unchanged`; last commit wins; each change audited with its version |
| Lock while a chat send or a live session is in flight | Messaging's millisecond window, documented; the live session continues ([§8.4](#84-lock-concurrency-and-idempotency)) |
| Remove racing redeem, same user | Pair lock: removed first → 403 `rejoin_requires_manager`; joined first → joined, then removed |
| Overlapping batch adds, removes, redeems, locks | Sorted pair locks, the global order, the community row last: no deadlock; a victim retries once, then 409 `communities.conflict` |
| The owner tries to leave, or someone removes the owner | 412 `owner_cannot_leave` / `owner_not_removable`; the CHECK is the backstop |
| Owner demoted, suspended or disabled | Owner-implicit capabilities dormant on the next request; grants keep working within their holders' ceilings; recovery by transfer through `communities.manage`; no eligible member → no recovery path (Q42) |
| Grantee loses the ceiling, or is suspended | The grant is dormant, not deleted; restored with the role |
| A delegate's act races the revocation of their grant, or their own removal | The basis is re-verified under lock: the act commits first, or is refused. Two delegates can never remove each other in one interleaving |
| Grant races removal of the grantee | The grantee's stint `FOR SHARE` vs `FOR UPDATE`: the grant is refused, or committed and then ended with the stint |
| Transfer races the removal of its target, or another transfer | Row locks, the one-owner index and the CHECK keep exactly one owner; the loser 409 `owner_conflict` |
| Member account suspended or disabled | The stint is untouched (Q13); the account cannot act; the roster shows the account inactive |
| Communities store unavailable, or the authorization statement times out | `authorize` rejects; Messaging, Live and Attendance fail closed with 503 and never fall back to a role-only answer |
| `AccountDirectory` fails during an add, grant or transfer | Refused before any write (503 once P0 adds the kind) |
| Token hash collision | Issue once more; a second collision is a fault (500) |
| Crash after commit, before the audit entry or event | The change is durable; its audit entry and event are lost — the existing system-wide gap with no outbox ([events.md §4](events.md#4-guarantees-stated-plainly)). Consumers re-ask; grant rows keep their own history; the outbox becomes mandatory on ADR 0021's triggers |
| Backend restart | Nothing to resume: invitation state is derived from columns and the clock; in-memory rate counters reset (accepted for development defaults); mock mode loses its data and is labelled mock |
| LiveKit, realtime or notifications unavailable | No effect: Communities depends on none of them. A community exists independently of any live room |
| A slow or failing subscriber | The bus isolates handler errors; Communities never waits for consumers |
| Several API instances | Invariants are the database's; per-process rate limits multiply until a Redis limiter exists |
| Bad cursor or limit | 422 `cursor_invalid` at the API (limit clamped); `RangeError` in the contract |
| Unknown capability or act string (client, database, old app) | 400 at the DTO; the CHECK refuses it at write; the Flutter enum maps it to `unknown` |
| An unmapped status read from the database | Every new action closed, management open, nobody ejected ([§8.3](#83-statepermits-and-communityheadeffects)) |

---

## 15. Security

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Leaked invitation link | 256-bit bearer token; mandatory expiry (at most 30 days, PROVISIONAL); optional `maxUses`; immediate revocation linearized with redemption; `community_members_invitation_idx` lists who joined through it, for removal; every redemption audited with its `invitationId`; only signed-in accounts with `communities.read`; REMOVED members cannot rejoin by link; LOCK suspends every link | Any eligible account holding the link before revocation can join, bounded by expiry and `maxUses` (Q48) |
| Brute force, enumeration | [§7.5](#75-brute-force-and-enumeration) | Rate limits per process until Redis; guessing is infeasible regardless |
| Token disclosure (logs, audit, events, responses) | Body key `token` redacted; never in a path or query; hash only at rest; shown once; tests search every sink for the token and its hash | People paste links into insecure chats; bounded by expiry |
| Unauthorized community access; forged client id, role or capability | Every route authorizes server-side from the rebuilt Principal and the database; `me` is display-only; join takes no id; consumers read the community id from their own records | None known |
| Teacher privilege escalation | Roles supply ceilings only; acts need ownership, a grant in that community, or oversight ([§6.14](#614-not-every-teacher-can-lock-every-community)) | None known |
| Delegation escalation | R1–R7: owner-only granting, ceiling-bounded, grantee-bounded, no self-grant (CHECK), dormancy, subset rule for removals | The owner may give any capability within ceilings to any eligible member; visible in the grant list and the audit (Q44) |
| A delegate removes the owner or a stronger peer | The owner cannot be removed (CHECK); R6; basis re-verified under lock | Peers with equal sets may remove each other sequentially (Q44) |
| Cross-community reuse of a grant; stale grants after rejoin | Grants keyed to one stint (composite FK); a rejoin is a new stint; grants ended with the stint; evaluation joins only the ACTIVE stint | None known |
| Speaker escalation to community powers | Speaker and presenter grants are Live state; the grants CHECK cannot hold them; a test asserts a speaker gains no act | None known |
| Confusing an act with an identity permission | Disjoint unions; `isPermission(act)` false; no `community` namespace ([§6.3](#63-the-act-vocabulary)) | None known |
| Oversight abuse: institution-wide reads of minors' rosters | `communities.manage` held by OWNER and ADMIN only (Q43); oversight never adds; every oversight read audited (PROVISIONAL) | The audit records access; it does not prevent it (Q43) |
| Roster scraping in large communities of minors | Roster hidden from ordinary members (Q22); pages ≤ 200; display names only, never emails; no `source`/`addedBy` | Owners, delegates with `members.view` and overseers can page every name (Q22) |
| Self-registration through a link | Authenticated route; public route set unchanged; no account creation (Q2) | None |
| Creation, link or grant spam | Per-user rate limits; bounded link lifetimes; no-ops write nothing | No cap on active links per community in v1 |
| Membership race abuse | Conditional `UPDATE`s, CHECKs, one lock order; every brief race tested | None known |
| CSRF on join, lock, remove | Bearer header authentication, not cookies | The web refresh cookie is Q17 and unused here |

---

## 16. Tests

**Domain (pure).**
- `decideCommunityAct` truth table: community missing; no stint with and without
  oversight; participation acts with and without a stint; OWNER with and without
  the ceiling; ACTIVE grant with and without the ceiling; member without basis;
  lifecycle refusal applied after the basis.
- Act rules: every ceiling names catalogued permissions only; every capability
  requires `communities.moderate`; participation acts only by membership;
  oversight reach exactly [§6.11](#611-oversight-communitiesmanage); the
  owner-implicit set is every capability (PROVISIONAL pins).
- Vocabulary: `isPermission(act) === false` for every act; no identity
  namespace equals `community`; `COMMUNITY_CAPABILITIES` equals the grants
  CHECK list; reserved names absent.
- Lifecycle: both tables of [§8.3](#83-statepermits-and-communityheadeffects),
  the unmapped row, and "never blocks `community.lock`".
- Invitation: state precedence at the boundaries (`now == expiresAt` ⇒ EXPIRED;
  `uses == maxUses` ⇒ EXHAUSTED); term validation; the 43-character shape.
- Stints and grants: terminal states; a rejoin is a new stint; grant state
  machine; R1–R7 including self-grant, subset rule with dormant grants,
  and transfer not to oneself on oversight.

**Application** (in-memory store, the real `PolicyAuthorizationService`,
`principalWith` from `test/support/principals.ts`).
- **Membership isolation**: for every community-scoped use case, a non-member
  gets 404 byte-identical to a missing id — including a principal holding every
  permission except `communities.manage`.
- **Teacher and delegated scope**: the [§6.14](#614-not-every-teacher-can-lock-every-community)
  matrix; a grant in A gives nothing in B; oversight locks, removes, lists and
  revokes links but never adds or creates links.
- Ceiling refusal happens with **no repository call** (spy).
- Re-authorization: every use case refuses a system principal lacking the
  permission when called without the guard.
- Invitation security: token returned once; never in lists, audit or events
  (serialize and search for token and hash); each refusal code exact.
- Idempotency: redeem twice ⇒ 201 then 200, one use, one audit, one event;
  lock twice ⇒ one audit, one event, version +1 once; add the same ids twice;
  revoke twice; grant twice.
- Journal: audit before event; nothing on no-ops; payload keys allow-listed.
- Contracts: `members()` returns each member exactly once across pages, honours
  `onlyUserIds` and `excludeUserId`, and throws `RangeError` on a bad cursor,
  limit 0 or > 1,000, or an oversized list; `statesOf` returns the latest stint,
  also when a rejoin's `joined_at` precedes the ended stint's (a clock step
  back); `heads` omits unknown ids; holders exclude dormant grantees, ended
  stints and overseers; `permittedAmong` agrees with `authorize` for every act
  and basis except oversight, which it never admits.
- Creator re-check (P2): a link whose owner-creator lost `communities.moderate`
  or was suspended answers 404 `invitation_invalid` and consumes no use.
- Rate limits answer `rate_limited` with `retryAfterSeconds`.

**Postgres** (P2 exit, then P3).
- Constraints: every named CHECK, partial unique index and the token-hash index
  exists and bites; no foreign key leaves the module (`pg_constraint`);
  `RESTRICT` blocks deleting a community with history; the composite FK refuses
  a mismatched grant.
- **20 parallel redeems by the same user** ⇒ one ACTIVE stint, `uses = 1`.
- **50 users against `max_uses = 10`** ⇒ exactly 10 stints, `uses = 10`,
  40 × `invitation_exhausted`, `member_count = count(ACTIVE)`.
- **Revoke racing 50 redeems** ⇒ `uses` = INVITATION stints, none joined after
  `revoked_at`.
- **Lock racing redeems and adds** ⇒ no stint after the lock commit; refused
  redeems consumed nothing. **10 concurrent locks** ⇒ `lifecycle_version + 1`,
  one audit row.
- **Deadlock freedom**: overlapping adds, removes, redeems, leaves and
  lock/unlock in parallel under `statement_timeout` ⇒ all complete, counts exact.
- **`changesSince` never skips a version while writers commit** (a reader
  looping during a concurrent storm reconstructs exactly the final ACTIVE set).
- P3 races: a delegate's removal vs revocation of their grant; two delegates
  removing each other; transfer vs removal of the target; two concurrent
  transfers ⇒ one owner, loser 409; **50 identical grants** ⇒ one row, one
  audit, one event; dormancy on ceiling loss; the holders keyset correct under
  churn.
- **30,000- and 100,000-member fixtures** (bulk insert, plus about a million
  stint rows overall): `EXPLAIN` shows index or index-only scans for the
  authorization statement, `statesOf`, roster, `members()`, my communities,
  `changesSince` and holders — never a sequential scan; `members()` walks
  30,000 in 30 pages exactly once; a query spy finds no `count(*)` in any
  request path and a fixed statement count per roster page and per "my
  communities" page, with one directory call each (no N+1); p99 of
  `authorize` at 30,000 is within tolerance of p99 at 30.
- Migrations: the 0009 upgrade test asserts exactly the four permissions and
  their grants are added and nothing removed; `identity-persistence.spec`
  equality stays green; the academic test pinned at 9 stays green.
- Mock parity: the in-memory store gives the same outcomes (each repository
  method a critical section with no `await` inside).

**API** (supertest): every status code of [§12](#12-api); a token in the query
string is ignored; unauthenticated join is 401; no response contains `@`.

**Architecture**: [§17](#17-module-layout-and-architecture-specs).

**Flutter**: wire models parse unknown statuses and capabilities; HTTP and mock
repositories behave alike (idempotent join, locked refusal, token shown once);
screens import no HTTP client or repository implementation; the join flow never
persists the token; buttons follow `me.capabilities` only.

**Load** (P8, measured, never guessed): profile 4 — the 30,000-member community,
a join storm through one link, full roster paging, `authorize` at join-storm
rates — on the target topology, reporting p50/p99 and throughput before any
capacity is stated, and asserting that pool wait, acquire timeouts and the p95
of an unrelated request mix stay bounded during the storm
([§9](#9-membership-at-30000-and-beyond)).

---

## 17. Module layout and architecture specs

```
backend/src/modules/communities/
  communities.module.ts          imports [IdentityModule]; exports the four tokens only
  contracts/                     index.ts, capabilities.ts, authorization.ts, membership.ts,
                                 directory.ts, capability-holders.ts, vocabulary.ts, events.ts
  domain/                        community.ts, membership.ts (stints), invitation.ts, grant.ts,
                                 lifecycle.ts (statePermits, LifecycleEffects),
                                 act-rules.ts (PROVISIONAL), authority.ts (decideCommunityAct),
                                 delegation.ts (mayDelegate, mayGrant, mayRemove, mayTransfer),
                                 events.ts (factories importing ../contracts/events), ports.ts, text.ts
  application/                   community-authorization.service.ts, community-membership.service.ts,
                                 community-directory.service.ts, capability-holders.service.ts,
                                 communities-journal.ts, community-people.ts (AccountDirectory, ≤ 1,000),
                                 communities-settings.ts, cursors.ts, views.ts,
                                 one use case per act: CreateCommunity, GetCommunity, ListCommunities,
                                 ChangeCommunityStatus, AddMembers, RemoveMember, LeaveCommunity,
                                 ListMembers, CreateInvitation, ListInvitations, RevokeInvitation,
                                 RedeemInvitation; P3: GrantCapabilities, RevokeGrant, ListGrants,
                                 TransferOwnership
  infrastructure/                schema.ts, drizzle-community-repository.ts,
                                 drizzle-community-read-model.ts, in-memory-community-store.ts,
                                 crypto-invitation-secrets.ts, row-mapping.ts
  api/                           communities.controller.ts, community-invitations.controller.ts,
                                 community-grants.controller.ts (P3), responses.ts, dto/
```

There is **no `CommunitiesService`** or `GroupService`: one use case per act,
one evaluator, one journal, pure domain functions. The Postgres or in-memory
adapter is chosen by `config.database.configured`, as in academic.

**Architecture specs it needs:**

| Spec | Asserts |
| --- | --- |
| `communities-boundaries.spec.ts` (new, academic template) | the layers appear in the graph; communities reaches identity only through `identity/contracts` and no other business module (messaging, live, attendance, academic, realtime, notifications, files); `communities.module.ts` imports only `identity.module.ts`, checked with `edgesFrom` because `reachableFrom` skips `*.module.ts` (`test/support/dependency-graph.ts:81`); other modules reach communities only through `contracts/` or the module file; only its infrastructure imports its schema, and it imports no other module's schema; the domain reaches only itself, its contracts, `identity/contracts/permissions.ts` and `src/shared`; domain and application import no drizzle, pg, ws, socket.io, express, ioredis, firebase, livekit-server-sdk or `node:crypto`; contracts import only `src/shared` and `identity/contracts/permissions.ts`, never the identity barrel, never live |
| `authorization.spec.ts` | the controller list gains the communities controllers; a route → permission map (`communities.read`, except creation and grant/revoke); the public route set unchanged |
| `notifications-boundaries.spec.ts`, `realtime-boundaries.spec.ts`, `academic-boundaries.spec.ts` | module lists derived from `src/modules/*` (P0) so communities is covered; `OTHER_SCHEMAS` gains the communities schema |
| `boundaries.spec.ts` / `events.spec.ts` (P0) | events typed only in `*/contracts/`; every `exports` identifier comes from `./contracts/`; no `forwardRef(` |
| `.dependency-cruiser.cjs` (P0) | the corrected vendor-SDK rule and `livekit-sdk-only-in-the-live-adapter`, each proven non-vacuous by `rules-match.spec.ts` |
| `role.spec.ts` | the ceiling invariants of [§6.2](#62-identity-ceilings); `communities.read ⇒ messaging.read` |
| a Nest wiring smoke test | `CommunitiesModule.imports` equals `[IdentityModule]`; `AppModule` compiles; `depcruise` reports 0 errors |

---

## 18. Relation to academic (Q50)

**No link in v1.** A community is not a halaqa, and academic does not own
generic group infrastructure. Communities never reads or writes enrollment,
and academic never owns communities
([Q50](open-questions.md#q50--communities-and-the-academic-structure)).

- **A halaqa link, if decided, is a reference only**: a nullable, immutable
  `halaqa_id` set at creation, validated through `ACADEMIC_RELATIONSHIPS`, that
  **grants nothing**.
- **Enrollment-sourced membership is an open question under the reconciliation
  hold.** It would be a `SYNC` source filled by a reconciliation job paging
  `activeStudentIds`, and capabilities derived from teaching would be a
  `CapabilitySource` seam inside Communities. None needs a contract change. It
  is not built because:
  - Q36 is open: whether a Tahajji «مجموعة» is a halaqa, a smaller group or a
    chat group;
  - the academic reconciliation holds Attendance and gates new modules
    (academic-reconciliation.md:19-21, 483-493);
  - `ACADEMIC_RELATIONSHIPS` ignores the halaqa's status
    (`academic/contracts/relationships.ts:15-18`), so it cannot say whether a
    halaqa is running (Q32);
  - academic events are in-process and not durable, so a synced copy would
    drift;
  - enrollment moves (Q30, Q37) would silently change communities.
- Naming the module `communities` and building no link keeps this design from
  answering Q36 by construction.

---

## 19. Open questions this module depends on

Every PROVISIONAL default above is one of these. Full text in
[open-questions.md](open-questions.md).

| Question | Provisional default used here |
| --- | --- |
| [Q40](open-questions.md#q40--governance-which-gates-apply-to-the-new-modules) Governance gates | The §13 gate applies; P2 waits for the §13 step (Q35/Q36 and ADR 0015) or the user's ruling on Q40 |
| [Q41](open-questions.md#q41--what-is-a-community-and-who-may-create-one) What a community is; who creates | `create`: OWNER, ADMIN; `read`: all six roles; no kind; PARENT inactive |
| [Q42](open-questions.md#q42--community-ownership) Ownership | One owner; implicit capabilities; cannot leave or be removed; transfer by owner or overseer, not to oneself; no recovery without an eligible member |
| [Q43](open-questions.md#q43--institutional-oversight-of-communities) Oversight | [§6.11](#611-oversight-communitiesmanage); oversight reads audited |
| [Q44](open-questions.md#q44--who-may-hold-delegated-capabilities) Delegates | `moderate`: TEACHER (+ OWNER, ADMIN); owner-only granting; R6 |
| [Q45](open-questions.md#q45--capability-grants-duration-handover-and-visibility) Grant lifecycle and visibility | No expiry; survive transfer; dormant on ceiling loss; owner sees all, holder own |
| [Q46](open-questions.md#q46--what-does-locked-mean-and-who-may-lock) LOCKED | [§8.2](#82-what-locked-means--provisional) |
| [Q47](open-questions.md#q47--retiring-a-community) Retiring | No ARCHIVED; never deleted |
| [Q48](open-questions.md#q48--invitation-links) Links | Invite holders create; overseers only list and revoke; 7 d default, 30 d max, 5 min min; optional `maxUses`; immediate join; no preview; creator re-checked |
| [Q49](open-questions.md#q49--leaving-removal-and-rejoining) Leaving and rejoining | Members may leave; REMOVED cannot rejoin by link; no reason field; only the removed person is told |
| [Q50](open-questions.md#q50--communities-and-the-academic-structure) Academic link | None in v1 |
| [Q51](open-questions.md#q51--the-community-chat-who-may-post) Chat posting | `chat.post`: owner or grant; refused while LOCKED |
| [Q54](open-questions.md#q54--who-starts-ends-and-moderates-a-live-session) Live authority | `live.start`, `live.host`, `live.moderate` as in §6.4 |
| [Q66](open-questions.md#q66--realtime-without-messagingread) Realtime gate | `communities.read ⇒ messaging.read`, pinned |
| [Q69](open-questions.md#q69--who-records-and-who-views-snapshots) Attendance acts | Reserved; ceilings without `attendance.*` |
| [Q1](open-questions.md#q1--what-may-each-role-actually-do), [Q13](open-questions.md#q13--what-do-suspended-and-disabled-mean-and-who-may-move-an-account-between-them), [Q20](open-questions.md#q20--messaging-limits), [Q22](open-questions.md#q22--who-may-see-who-is-in-a-conversation), [Q26](open-questions.md#q26--realtime-limits), [Q3](open-questions.md#q3--what-is-the-retention-policy-for-files-messages-audit-entries-and-session-history) (existing) | Role matrix provisional; suspension leaves stints; no size limit; roster hidden from members; development-safe rate limits; nothing deleted |

---

## 20. Deferred

- **ARCHIVED** (Q47): one vocabulary value, one CHECK migration, one row per
  lifecycle table.
- **Sub-delegation, time-boxed grants, approval before joining, link
  previews**: each a policy answer first (Q44, Q45, Q48).
- **Halaqa link and SYNC membership** (Q50), after Q36 and the reconciliation.
- **`community.messages.moderate`** (Q51/Q23): one constant, one act-rules row,
  one CHECK change.
- **A member limit** (Q20): a nullable column in the same conditional `UPDATE`.
- **The outbox and a Redis rate limiter** (P11), on ADR 0021's triggers.
