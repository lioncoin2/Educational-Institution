# P6 — Live implementation plan

**Community-scoped live sessions, backend only.**

- **Gate:** [`p6-live-readiness-audit.md`](p6-live-readiness-audit.md), **P6 READINESS: PASS**.
- **Design:** [`docs/architecture/live.md`](architecture/live.md), APPROVED. Where this plan says "design
  §n", that document is meant.
- **Scope:** as reconciled in audit §2, with the decisions of audit §16 (D1–D24).
- **Repository at start:** `1f000de`.

**What P6 delivers.** P6 is complete when every acceptance criterion in §5 holds:

- the architecture is clean;
- Communities remains the membership authority;
- Live owns the session lifecycle;
- the provider stays behind its port, and no LiveKit type leaks;
- authorization is server-side;
- the lifecycle is durable;
- concurrency is safe;
- failure is explicit;
- the fake is deterministic;
- realtime is only a hint;
- Attendance stays separate;
- no policy is invented;
- tests prove the boundaries;
- dependency checks and migrations are clean;
- no test is skipped.

---

## 1. Slice order and commits

Every commit leaves `npm run verify` green, with `TEST_DATABASE_URL` set so no Postgres suite skips. The
brief's slices are regrouped so each commit compiles and passes on its own. The old halaqa-bound model
cannot coexist with the new one, so the domain, the application layer and the API move together (commit
B).

| Commit | Brief slices | Content |
| --- | --- | --- |
| **A** | P6.1 (Communities part), platform | `permittedAmong`; `community.live.remain`; `KeyedMutex` moved to `platform/concurrency` |
| **B** | P6.1 (identity part), P6.2, P6.4, P6.5, P6.6 (the fake) | Live's domain, contracts and limits; `AppConfig.live` and the fail-closed provider binding (audit D19); the extended fake and the disabled provider; the in-memory repositories; `LiveAccess` and every use case; the API; `host-only-moderation` retired **in the same commit** as `LiveAccess` |
| **C** | P6.2 (Postgres) | `live/infrastructure/schema.ts`, migration `0013_live_sessions.sql`, Drizzle repositories, the database switch, a mock-parity contract suite |
| **D** | P6.4 (convergence) | `LiveReconciler` (with audit D21–D23), `ProtectLiveSessions`, `LiveAudienceService`, `LiveSessionsReader`, module exports |
| **E** | P6.7 | `LiveRealtimeRelay`, live frames and coalescing, fixtures in `test/fixtures/realtime-frames/live/` |
| **F** | P6.8 | the adversarial, concurrency, restart, outage, scale (`EXPLAIN`, statement budgets) and token-scope suites; the recorded mutation checks |
| **G** | P6.9 | boundary specs; documentation, including a dated amendment note on ADR 0019; the phase table; README counts; the final gate |

After G comes an adversarial review of the whole P6 diff. Each confirmed finding gets a fix and a
regression test that failed first. P6 then stops for the user's review.

---

## 2. Contracts

### 2.1 Communities (commit A)

```ts
// communities/contracts/capabilities.ts
/** Derived acts. community.live.host: backed by community.live.start (the host's own session).
 *  community.live.remain (P6): staying in a running session; join's ceiling and membership basis,
 *  gated by runningLiveContinues instead of liveJoinOpen. Neither is a capability; no grant names one. */
export const COMMUNITY_DERIVED_ACTS = ['community.live.host', 'community.live.remain'] as const;

// communities/contracts/authorization.ts — added to CommunityAuthorization
/**
 * P6. Trusted and principal-less (Live's reconciler, LIVE_AUDIENCE, a grant's target check).
 * Of `userIds` (at most MAX_AUTHORIZE_BATCH; RangeError above), those this act would permit:
 * the act's standing ceiling (identity, through ACCOUNT_DIRECTORY.withPermission), then the
 * owner, grant or membership basis (NEVER oversight), then the lifecycle gate — the same
 * evaluator `authorize` runs. Deduplicated, in the order given. An unknown community → [].
 * A store or directory failure REJECTS: never [] for "could not tell".
 */
permittedAmong(communityId: string, userIds: readonly string[], act: CommunityAct): Promise<readonly string[]>;
```

**Store.** `CommunityStore.authorityOfMany(communityId, userIds)` returns the community's status and each
id's ACTIVE stint with its ACTIVE grants. It is one statement in Drizzle: the community by id, LEFT JOIN
the ids' ACTIVE stints through `community_members_current_unique`, LEFT JOIN their ACTIVE grants. The
in-memory store gets a twin.

**The rule for `community.live.remain`** (audit D3):

| Field | Value |
| --- | --- |
| kind | `participation` (the membership basis) |
| standing ceiling | `[communities.read, live.join]` |
| `ownerImplicit` | false (the owner is a member) |
| oversight | none |
| gate | `runningLiveContinues` |
| `backingCapability` | null |

Neither `me.capabilities` nor `me.participation` lists it. No migration: it is not a capability, so the
grants CHECK is unchanged.

### 2.2 Live's public contracts (commits B and D)

```ts
// live/contracts/events.ts — names unchanged where they exist; payloads per design §14
export const LiveEvents = {
  sessionStarted: 'live.session.started', sessionEnded: 'live.session.ended',
  speakerRequested: 'live.speaker.requested', speakerGranted: 'live.speaker.granted',
  speakerDeclined: 'live.speaker.declined', speakerRevoked: 'live.speaker.revoked',
  speakerWithdrawn: 'live.speaker.withdrawn', speakerExpired: 'live.speaker.expired',
  screenShareStarted: 'live.screen_share.started', screenShareStopped: 'live.screen_share.stopped',
} as const;
// aggregateId = sessionId for all. Payloads, ids/codes/versions only:
// started   {sessionId, communityId, hostUserId}
// ended     {sessionId, communityId, endedBy: string | null, reason: 'moderator'|'idle'|'community_closed', durationSeconds}
// requested {sessionId, communityId, requestId, userId, stateVersion}
// granted / declined / revoked  {…requested fields, grantedBy | declinedBy | revokedBy}
// withdrawn {…, from: 'pending'|'granted'}   expired {…, from, cause: 'ineligible'} (never for End)
// screen_share.started {sessionId, communityId, userId, grantedBy, stateVersion}
// screen_share.stopped {sessionId, communityId, userId, stoppedBy: string | null, reason: 'stopped'|'revoked'|'ineligible', stateVersion}

// live/contracts/participant-role.ts — unchanged
export type LiveParticipantRole = 'moderator' | 'speaker' | 'listener';

// live/contracts/live-sessions.ts (commit D) — Live's own record; never the provider; no principal
export const LIVE_SESSIONS = Symbol('LIVE_SESSIONS');
export interface LiveSessionScope {
  readonly liveSessionId: string; readonly communityId: string;
  readonly hostUserId: string; readonly active: boolean;
}
export interface LiveSessions { describe(liveSessionId: string): Promise<LiveSessionScope | null> }

// live/contracts/live-audience.ts (commit D) — for realtime's relay
export const LIVE_AUDIENCE = Symbol('LIVE_AUDIENCE');
export const MAX_AUDIENCE_PROBE = 1000;
export interface LiveAudience {
  /** Of userIds (≤ 1000; RangeError above): who may take part now, ignoring session state —
   *  permittedAmong(C, ids, community.live.join) ∪ moderators among them. Unknown session → []. */
  participantsAmong(sessionId: string, userIds: readonly string[]): Promise<readonly string[]>;
  /** community.live.moderate holders (COMMUNITY_CAPABILITY_HOLDERS) plus the host while
   *  permittedAmong(C, [host], community.live.host) accepts them. Keyset pages, limit 1..1000;
   *  [] for an ended or unknown session. */
  moderators(sessionId: string, page: { readonly cursor?: string | null; readonly limit: number }):
    Promise<{ readonly userIds: readonly string[]; readonly nextCursor: string | null }>;
}
```

`LiveModule.imports` becomes `[IdentityModule, CommunitiesModule]`; `exports: [LIVE_AUDIENCE, LIVE_SESSIONS]`
(commit D). Live's `contracts/` import nothing but `src/shared/`.

### 2.3 Live domain (commit B)

These implement design §3 exactly:

| File | Contents |
| --- | --- |
| `live/domain/live-session.ts` | `LiveSession` (§3.1 fields); `isLive`; `mediaRoomName(prefix, id, epoch)`, which appends `'.' + epoch` when the epoch is above 0; `isMediaRoomName(prefix, name)`, an exact `prefix + uuid [+ '.' + n]` match |
| `live/domain/speaker-request.ts` | six states; `ALLOWED_TRANSITIONS` extended with `expired` (from `pending` or `granted`); `MAX_CONCURRENT_SPEAKERS = 4`; FCFS order |
| `live/domain/presenter-grant.ts` | `PresenterGrant {id, sessionId, userId, grantedBy, grantedAt, endedAt?, endedBy?, endReason?}`; the four end reasons |
| `live/domain/moderation.ts` | the ten types of design §3.5; `actorUserId: string \| null`; an audit action per type (below) |
| `live/domain/standing.ts` | `ParticipantStanding {moderator, publishesByRight, speakerGrant, presenter}`; `capabilitiesFor(standing)`, total (audit §8.4); `roleOf(standing)` = moderator > speaker > listener |
| `live/domain/live-limits.ts` | every PROVISIONAL bound of audit §8.5, with its question in a comment. `ENFORCEMENT_WATCH_SECONDS = 660` (design §3.8). `JOIN_TOKEN_TTL_SECONDS = 120`, pinned by a test to a positive integer ≤ 600 and checked again at the call site (audit D24) |
| `live/domain/ports.ts` | the repository ports of §2.4 |
| `live/domain/rtc-provider.ts` | **unchanged**, apart from deleting the `LISTENER` and `SPEAKER` constants (design §3.1) in favour of `capabilitiesFor` |

**Deleted:** `live/domain/live-room.ts`, `LiveRoomRepository`, `LIVE_ROOM_REPOSITORY`, `live.room_not_found`,
and `application/capability-convergence.ts` (audit D11).

**Audit action names** (`AUDIT_ACTION_BY_MODERATION`):

| Moderation type | Audit action |
| --- | --- |
| `start_session` | `live.session.started` |
| `end_session` | `live.session.ended` |
| `grant_speaker` | `live.speaker.granted` |
| `decline_speaker` | `live.speaker.declined` |
| `revoke_speaker` | `live.speaker.revoked` |
| `grant_presenter` | `live.screen_share.started` |
| `revoke_presenter` | `live.screen_share.revoked` |
| `reset_media` | `live.session.media_reset` |
| `mute_participant` (seam) | `live.participant.muted` |
| `remove_participant` (seam) | `live.participant.removed` |

### 2.4 Repository ports (commit B defines them, with in-memory adapters; commit C adds Drizzle)

Design §10.3, refined for the outcomes the use cases need:

```ts
interface LiveSessionRepository {
  findById(id: string): Promise<LiveSession | null>;
  findLiveByCommunity(communityId: string): Promise<LiveSession | null>;
  /** INSERT … ON CONFLICT (community_id) WHERE state = 'live' DO NOTHING RETURNING, + the start_session row. */
  start(session: LiveSession, moderation: ModerationAction): Promise<{ created: boolean; session: LiveSession }>;
  /** §4.2 in one transaction: lock, set ended, expire open requests (one statement), close the open
   *  presenter grant (one statement), the end_session row. null for an unknown id. */
  end(input: { sessionId: string; at: Date; endedBy: string | null;
               reason: 'moderator' | 'idle' | 'community_closed'; moderation: ModerationAction }):
    Promise<{ ended: boolean; session: LiveSession } | null>;
  listLive(after: { startedAt: Date; id: string } | null, limit: number): Promise<readonly LiveSession[]>;
  markEmpty(id: string, emptySince: Date | null): Promise<void>;
  noteViolation(id: string, at: Date): Promise<number>;
  /** compare-and-set media_room_epoch expected → expected + 1, with the reset_media row. */
  bumpEpoch(id: string, expected: number, moderation: ModerationAction): Promise<LiveSession | null>;
}
interface SpeakerRequestRepository {
  raise(request: SpeakerRequest): Promise<{ created: boolean; request: SpeakerRequest; stateVersion: number } | 'session_not_live'>;
  findById(id: string): Promise<SpeakerRequest | null>;
  findOpen(sessionId: string, userId: string): Promise<SpeakerRequest | null>;
  granted(sessionId: string): Promise<readonly SpeakerRequest[]>;            // ≤ 4 rows
  pendingPage(sessionId: string, after: { requestedAt: Date; id: string } | null, limit: number):
    Promise<readonly SpeakerRequest[]>;                                       // limit ≤ 100
  countPending(sessionId: string, cap: number): Promise<number>;             // reads ≤ cap rows (audit D8)
  grantWithinCap(input: { requestId: string; cap: number; at: Date; by: string; moderation: ModerationAction }):
    Promise<{ kind: 'granted' | 'unchanged' | 'slots_full' | 'invalid' | 'session_not_live'; request: SpeakerRequest; stateVersion: number } | null>;
  transition(input: { requestId: string; from: readonly SpeakerRequestState[]; to: SpeakerRequestState;
                      at: Date; by: string | null; moderation: ModerationAction | null }):
    Promise<{ kind: 'applied' | 'unchanged' | 'invalid' | 'session_not_live'; request: SpeakerRequest; stateVersion: number } | null>;
  /** The ineligible expiry: expires that user's open request AND closes their open presenter grant
   *  ('ineligible') in one transaction under the session lock; +1 state_version if anything changed. */
  expireIneligible(sessionId: string, userId: string, at: Date):
    Promise<{ request: SpeakerRequest | null; presenter: PresenterGrant | null; stateVersion: number }>;
  floorClosedSince(sessionId: string, since: Date): Promise<readonly string[]>;  // the watch
}
interface PresenterGrantRepository {
  active(sessionId: string): Promise<PresenterGrant | null>;
  open(grant: PresenterGrant, moderation: ModerationAction):
    Promise<{ kind: 'opened' | 'held' | 'occupied' | 'session_not_live'; grant: PresenterGrant | null; stateVersion: number }>;
  close(input: { sessionId: string; by: string | null; reason: 'stopped' | 'revoked' | 'ineligible';
                 at: Date; moderation: ModerationAction | null }):
    Promise<{ grant: PresenterGrant | null; stateVersion: number }>;          // grant null → nothing open
  closedSince(sessionId: string, since: Date): Promise<readonly string[]>;
}
```

**Every port rule:**
- No method returns every request of a session.
- Every state change locks the session row first and requires `state = 'live'`, except
  `markEmpty`/`noteViolation`, whose single-row UPDATE is itself `WHERE state = 'live'`.
- Every change a moderator can observe raises `state_version` by exactly 1 in the same transaction.
- Provider calls never happen inside a repository.
- *(2026-09-27, commit F.)* `grantWithinCap`'s count of granted rows is bounded: it reads at most
  `cap` rows, as `countPending` does.
- Drizzle adapters take the per-session `KeyedMutex` (`platform/concurrency`) before checking out a
  connection for any locked transition (design §10.2).

### 2.5 Configuration (commit B)

`AppConfig.live`:

| Field | Source | Default | Validation |
| --- | --- | --- | --- |
| `maxParticipantsPerSession` | env `LIVE_MAX_PARTICIPANTS_PER_SESSION` | 300 | integer ≥ 1 |
| `moderatorReserve` | env `LIVE_MODERATOR_RESERVE` | 10 | integer ≥ 0 |
| `roomNamePrefix` | env `LIVE_ROOM_NAME_PREFIX` | `null` when unset | `^[A-Za-z0-9._-]{1,48}$` |
| `mediaProvider` | env `LIVE_MEDIA_PROVIDER` | `null` unless it is exactly `livekit` | — |

**The provider binding (audit D19).** It lives in `live.module.ts`'s factory, with its checks in
`app-config.ts`, where the other boot refusals are:

| Configuration | Binds |
| --- | --- |
| `livekit.apiSecret` is the development secret | the fake (as today); a null prefix means `live-` |
| `mediaProvider === 'livekit'` | `LiveKitRtcProvider`. **Boot is refused** unless all of these hold: `LIVE_ROOM_NAME_PREFIX` is set; `LIVEKIT_API_KEY` is not in `PLACEHOLDER_SECRETS`; `LIVEKIT_API_SECRET` has at least 32 bytes (the JWT bound) |
| anything else, including every production boot today | the new `DisabledRtcProvider` (`live/infrastructure/disabled-rtc-provider.ts`): every method throws `RtcUnavailableError('media disabled')` |

- The factory logs which it bound, and the prefix.
- **Other files:** `.env.example` and the backend README gain the four variables. The adapter file is
  not edited.
- **Specs:**
  - `live.module.spec.ts` covers the binding: each row above, and every boot refusal.
  - `disabled-rtc-provider.spec.ts` checks that every method refuses.

### 2.6 Realtime frames (commit E)

These are additive to protocol v1, following hub §16.2:

| Frame | Payload | `eventId` |
| --- | --- | --- |
| `live.session.started` | `{communityId, sessionId}` | `live.session.started:<sessionId>` |
| `live.session.ended` | `{communityId, sessionId, reason}` | `live.session.ended:<sessionId>` |
| `live.session.changed` | `{communityId, sessionId, stateVersion}` | `live.session.changed:<sessionId>:<stateVersion>` |

Every frame carries `eventId` and `occurredAt`, as the existing `community.*` frames do. The golden copies
live in `backend/test/fixtures/realtime-frames/live/` (audit D16), with a README line noting that the app
reads them from its live phase.

---

## 3. Slices: files, behaviour, tests

### Commit A — Communities additions

**Files:**

| Action | Files |
| --- | --- |
| Modify, Communities contracts | `communities/contracts/capabilities.ts` (`COMMUNITY_DERIVED_ACTS`); `communities/contracts/authorization.ts` (`permittedAmong`) |
| Modify, Communities domain | `domain/act-rules.ts` (`remain`'s rule: an explicit kind, not name-derived); `domain/lifecycle.ts` (`GATE_OF_ACT`); `domain/ports.ts` (`authorityOfMany`) |
| Modify, Communities implementation | `application/community-authorization.service.ts` (`permittedAmong`: ceilings through `CommunityPeople.eligible` per ceiling permission, one store read, `decideCommunityAct` with oversight false); `infrastructure/drizzle-community-repository.ts`; `infrastructure/in-memory-community-store.ts` |
| Move | `communities/infrastructure/keyed-mutex.ts` → `platform/concurrency/keyed-mutex.ts` (+ spec); Communities imports it from there |

**Tests:**
- **Pins in `act-rules.spec.ts`:** `remain`'s full row. The statements that change:
  - "every derived act needs `communities.moderate`" becomes "every derived act backed by a capability";
  - participation is "the membership-basis acts", which now include `remain`.
- **`lifecycle.spec.ts`:** `remain` is open under OPEN, LOCKED and unmapped.
- **`authority.spec.ts`:** a member with the ceiling is permitted `remain` under every status; a
  non-member is refused; the owner is permitted; a grant never gives it; oversight never gives it.
- **The shared contract suite (`test/support/communities-contract-suite.ts`), run against both
  stores.** `permittedAmong`:
  - **agrees with `authorize` for every act**, over a matrix of owner, member, delegate (per
    capability), overseer, non-member, former member, suspended account and an account missing a
    ceiling, under OPEN and LOCKED;
  - never permits by oversight;
  - `[]` for an unknown community;
  - RangeError above 1,000;
  - duplicates collapse and order is kept.
- **Failure:** a spy makes the store, and separately the directory, fail, and the promise rejects.
- **Postgres** (`communities-postgres.spec.ts`): the statement count is constant, 1 read + ≤ 2
  `withPermission` pages per 1,000 ids.
- **Scale** (`communities-scale.spec.ts`): `EXPLAIN` of the new read at 30,000 and 100,000 members is
  index-served.

**Acceptance:**
- `npm run verify` green.
- Every existing Communities test is unchanged apart from the two rewritten statements.
- `me` is byte-identical: the API spec pins its keys.

### Commit B — Live core, in memory, and the API

**Files.**

| Action | Files |
| --- | --- |
| Rewritten | `live/domain/*` (§2.3); `live/contracts/events.ts`; `live/application/*` (below); `live/infrastructure/in-memory-live-repositories.ts`; `live/infrastructure/fake-rtc-provider.ts` (below); `live/api/live.controller.ts`; `live/api/dto/*`; `live/api/responses.ts`; `live/live.module.ts` |
| Modified, identity | `identity/domain/provisional-policy.ts` (`PROVISIONAL_POLICY_RULES = Object.freeze([])`); `identity/domain/role.spec.ts` (expects `[]`); `identity/application/authorization.service.spec.ts` (the host-only case removed; `restrictToResourceOwner`'s own spec stays) |
| Modified, platform | `platform/config/app-config.ts` (+ spec); `backend/.env.example` |
| Rewritten test support | `test/support/live-harness.ts` (sessions seeded through `StartLiveSession`, never through a repository); `test/api/live.api.spec.ts` |

**The application layer** (`live/application/`). Every file is injectable, and each does one thing.

**`live-access.ts` — `LiveAccess`** (design §7.2):
- `moderator(P, S)`, in this order:
  1. `authorize(P, S.communityId, 'community.live.moderate')` → a permit means **moderator** (owner or
     grant basis).
  2. Else, when `P.userId === S.hostUserId`, `community.live.host` → a permit means **moderator via
     host**.
  3. Otherwise a refusal:

     | Communities' answer | Live's answer |
     | --- | --- |
     | `not_found`, or identity's ceiling refusal | 404, the route's own not-found code |
     | `forbidden` with `communities.capability_required` | 403 `live.not_a_moderator` |
     | a rejection | 503 `unavailable` |
- `participant(P, S)`: a `community.live.join` permit, else `moderator(P, S)`, with the lifecycle
  refusal reported separately (412 `live.community_not_open`).
- The permit is returned so the journal can record `{act, basis, membershipId, grantId}`.
- Nothing is cached across requests.

**`live-standing.ts` — `LiveStanding`:**

| Method | Used by | Standing from |
| --- | --- | --- |
| `ofPrincipal(P, S, access)` | join and views | the moderator answer; identity `can(P, live.speak)` with **no `ownerUserId`**; the caller's open request; the open presenter grant |
| `ofAccounts(S, userIds)` | the reconciler, principal-less | batched: `permittedAmong` for `remain`, `moderate`, and the host's `host`; `ACCOUNT_DIRECTORY.withPermission(live.speak)`; the granted rows; the presenter row |

**`community-calls.ts`** is Live's own `askCommunities`. A rejection becomes 503 `unavailable`, and the
error is logged by class only (audit D14).

**`start-live-session.use-case.ts`** (design §4.1, audit D1):
1. Rate limit per user, 10 per 60 s → 429 `live.too_many_starts`.
2. `authorize(start)`:

   | Communities' answer | Live's answer |
   | --- | --- |
   | `not_found` | 404 `live.community_not_found` |
   | `forbidden` | 403 `live.start_not_permitted` |
   | `precondition_failed` | 200 with the running session if there is one, else 412 `live.community_not_open` |
3. The live session already exists → 200 with its view, and no provider call.
4. `ensureRoom({roomName, maxParticipants: cap + reserve, emptyTimeoutSeconds: 1200,
   departureTimeoutSeconds: 1200})`. `RtcUnavailableError` → 503 `live.media_unavailable`, with nothing
   stored. This includes the disabled provider of audit D19.
5. **Re-ask `community.live.start`** (audit D20). If it is refused now, `endRoom` the room this call
   ensured (best effort) and return the refusal, remapped as in step 2.
6. `start(...)`. On a lost race, `endRoom` the room this call ensured, best effort and logged, then 200
   with the winner.
7. Created: audit `live.session.started` with `{communityId, permit}`, then the event, then 201.

**`end-live-session.use-case.ts` and `live-session-lifecycle.ts` (`endBySystem(id, reason)`).** Both use
the repository's `end`:
- `ended: false` → 200 with the view: no audit, no event, no provider call.
- `ended: true` →
  1. audit (the actor is null for a system end);
  2. **one** `live.session.ended`;
  3. `endRoom(mediaRoomName(prefix, id, epoch))`, best effort. NotFound counts as success; an outage is
     left to the room sweep.
- Any session moderator may end (audit D2).

**`get-live-session.use-case.ts` and `get-current-live-session.use-case.ts`.**
- Visibility is `community.live.join`, where a lifecycle refusal still shows the view with
  `me.canJoin: false`, or a moderator.
- Otherwise 404: `live.session_not_found` or `live.community_not_found`.

**`join-live-session.use-case.ts`** (design S2):
1. Rate limit per (session, user), 10 per 60 s → 429 `live.too_many_joins`.
2. Load the session → 404.
3. `LiveAccess.participant` → 404 or 412.
4. The session is not live → 412 `live.session_not_live`.
5. Standing.
6. Room sample from `listRooms([room])`, cached ≤ 2 s per instance:
   - missing → `ensureRoom`, then re-read: ended → `endRoom` and 412;
   - a **listener** over the soft cap (the sample plus listener tokens this instance issued since the
     sample) → 412 `live.session_full`;
   - `RtcUnavailableError` → skip both checks and fail open to the hard cap.
7. The directory name (`''` if absent).
8. `issueAccessToken`, with the TTL checked to be an integer in 1..600 first (audit D24).
   `RtcUnavailableError` → 503 `live.media_unavailable`, which covers the disabled provider.
9. `JoinTicket`.

Nothing is written, audited or published.

**`raise-hand.use-case.ts`:**
1. Rate limit per (session, user), 6 per 60 s → 429 `live.too_many_hands`.
2. Load the session → 404.
3. The `community.live.raise_hand` permit → 404 or 412.
4. The session is not live → 412.
5. Fast path: an open request → 200 with it.
6. Otherwise `raise`:
   - created → the event, then 201;
   - an open request raced in → 200;
   - `session_not_live` → 412.

**`lower-hand.use-case.ts`** (audit D9, D4). The caller's open request comes first, found by
(session, user):

| Outcome | Answer |
| --- | --- |
| An open request; `pending` or `granted` → `withdrawn` applied (no permit is needed: it only reduces privilege) | the event `withdrawn {from}`; a yield also pushes the full capability set and watches; 200 |
| The write finds it already `withdrawn` | 200, unchanged |
| The write finds it `expired` (the session ended meanwhile) | 200 `{request: null}` |
| The write finds it `revoked` or `declined` | 409 `live.invalid_transition` |
| **No open request** | the session must exist and be visible to the caller (`LiveAccess.participant`, the lifecycle refusal included), else 404 `live.session_not_found`; then 200 `{request: null}` |

**`moderate-speaker.use-case.ts`** (`grant`, `decline`, `revoke`):
1. The coarse `live.moderate` check, before any read.
2. Load the request and its session → 404 `live.request_not_found`.
3. `LiveAccess.moderator` → 404, 403 or 503.
4. The target is the host and the moderator's authority is not the host's own → 403
   `live.target_is_host`.
5. A repeat of the current state → 200 `unchanged` (audit D6).
6. `grant` only: the target is eligible — `permittedAmong(remain)`, else a moderator — or 412
   `live.target_not_eligible`.
7. The repository transition:

   | Outcome | Answer |
   | --- | --- |
   | `slots_full` | 412 `live.speaker_slots_full` |
   | `invalid` | 409 `live.invalid_transition` |
   | `session_not_live` | 412 `live.session_not_live` |
8. After commit, for `grant` and `revoke`: push the target's full current set, reporting `media`:
   - `applied` or `not_connected`;
   - `pending` on an outage or a fault, which also adds the target to the watch.
9. The journal: audit with `{targetUserId, requestId, media, permit}` and the correlation id, then the
   event with `stateVersion`.

**`list-hands.use-case.ts`:**
- `LiveAccess.moderator`.
- `state=pending` → a keyset page of `limit` 1..100 (default 50) with an opaque cursor, following the
  `communities/application/cursors.ts` pattern.
- `state=granted` → ≤ 4 rows.
- Names from `ACCOUNT_DIRECTORY.describe` for the page, never an email.
- Granted rows add `media: connected | not_connected | unknown`, the reconciler's last observation
  (audit D7).

**`presenter.use-case.ts`:**

| Operation | Rule | Answer |
| --- | --- | --- |
| `claim` | `LiveAccess.moderator` + identity `live.speak`, or 403 `live.presenter_not_permitted`; `open` | `opened` → push, audit, event, 201; `held` → 200; `occupied` → 409 `live.presenter_slot_taken`; `session_not_live` → 412 |
| `stop` by the presenter | no permit needed | `close('stopped')`: event, push, 200 |
| `stop` by anyone else | `LiveAccess.moderator`; nothing open → 200; the host's grant and authority not the host's own → 403 `live.target_is_host` | `close('revoked')`: moderation row, audit, event, push, 200 |

**`live-journal.ts`:**
- `record(audit | null, events)` after commit: audit first, then the events; never on a no-op.
- `correlationId` comes from `@RequestMetadata()`.

**`views.ts`:** `LiveSessionView`, `SpeakerRequestView`, `JoinTicket`, `ModerationResult`, `HandsPage`
(design §15.3; audit §11). `moderation.pendingHands` is `countPending(sessionId, 100)`.

**The API** (`live/api/live.controller.ts`):
- the thirteen routes of audit §11, each with exactly one access declaration;
- `@UseInterceptors(DatabaseUnavailableInterceptor)`, imported from
  `platform/http/database-unavailable.interceptor`, never from the database barrel;
- `@RequestMetadata()`;
- 201 or 200 through `@Res({passthrough: true})`, as the hand route does today;
- a query DTO for the hands page;
- `api/responses.ts` maps views to JSON with dates as ISO strings;
- `test/architecture/authorization.spec.ts` keeps `LiveController` in its list, and every new route is
  pinned in its route → permission map.

**The fake** (`live/infrastructure/fake-rtc-provider.ts`, audit §9):
- a room registry and an injected clock;
- `failNext(operation, 'unavailable' | 'fault')` and `hold(operation)` / `release()`;
- a call log that includes reads;
- removal options recorded;
- observations follow `updateCapabilities` and `removeParticipant`;
- bounded buffers;
- its own spec, `fake-rtc-provider.spec.ts`.

**Tests in commit B.**

**Unit and application tests, over the in-memory repositories.** They use the real
`PolicyAuthorizationService` with the now-empty rule list, and a **real** `CommunityAuthorizationService`
over the in-memory Communities store, so Live is tested against Communities' actual rules, never a copy.

- **Domain:**
  - `ALLOWED_TRANSITIONS` over every (from, to) pair;
  - `capabilitiesFor` over every standing: a listener publishes nothing; a grant adds the microphone
    only; a moderator without `live.speak` has no microphone; the presenter gets the screen; nothing
    maps to the camera; data, screen audio and `hidden` are always false;
  - `mediaRoomName` and `isMediaRoomName` for epochs 0 and n, and a prefix that merely starts with
    another's;
  - the limits' pins.
- **Start:** idempotent (one row, one audit, one event); a lost race ends the stray room; a provider
  outage → 503 with nothing stored; 404, 403, 412; start, lock, start again → 200 with the running
  session; the rate limit.
- **Join:**
  - a non-member → 404, like an unknown session; a member of another community → 404; an ended session
    → 412; LOCKED → allowed;
  - the name comes from the directory;
  - the role matrix: a delegated moderator who did not start is a moderator; the host is a moderator; a
    moderator without `live.speak` has no microphone; OWNER without standing is a listener or 404;
    a revoked grant gives no microphone; a grant survives a reconnect;
  - ensure-then-recheck with End between → 412;
  - the soft cap: tokens since the sample count; moderators and speakers are exempt; an observer outage
    fails open;
  - the rate limit, keyed by (session, user), never by IP.
- **Raise:** 201, then 200 with one event; LOCKED allowed; a non-member → 404.
- **Lower:** each row of the table above, **including lower racing a grant, which ends as a yield**.
- **Moderate:**
  - grant, decline and revoke, with their repeats;
  - `target_is_host`;
  - `target_not_eligible` (a removed member; a suspended account);
  - the cap;
  - an audit per act, carrying the permit basis;
  - `media` for each outcome.
- **End:** expires every open hand and closes the presenter grant, with no per-hand events; a repeat
  → 200, with no audit, event or provider call; a system end is audited with a null actor.
- **Presenter:** every rule in the table above.
- **Authorization migration:**
  - an all-permission principal (OWNER) without community standing cannot moderate, end or present, and
    nothing changes (no provider call, audit or event);
  - no Live use case passes `ownerUserId` (a spy on the identity context);
  - `PROVISIONAL_POLICY_RULES` is `[]`;
  - a speaker grant confers no community act.
- **Communities outage:** `authorize` rejects → 503 `unavailable` on every route that asks; never a
  role-only answer.

**API tests** (`test/api/live.api.spec.ts`, over HTTP with in-memory stores):
- every route's status codes and shapes;
- no body accepted anywhere;
- the refusal-code table of audit §11;
- the join ticket never appears in a log line: captured logs are scanned for JWT-shaped strings and for
  the fake's token pattern.

**Acceptance:**
- `npm run verify` green.
- The P1 properties the audit keeps are still asserted: a listener cannot publish; raise is idempotent;
  names come from the directory; the TTL is 120; one audit action per act.

### Commit C — Postgres

**Files:**
- `live/infrastructure/schema.ts`: four tables per design §10.1, with every CHECK built from the domain
  constants. The pattern is `communities/infrastructure/schema.ts`.
- `backend/drizzle/0013_live_sessions.sql`: a header comment and the four tables. It touches **no
  existing table**: identity's seeded descriptions stay, proposed separately (audit §17.12). The journal
  and snapshot are generated by drizzle-kit.
- `live/infrastructure/drizzle-live-repositories.ts`: READ COMMITTED; the session row `FOR UPDATE`
  first; the per-session `KeyedMutex`; `ON CONFLICT` on the partial unique indexes; set-based End.
  `isUniqueViolation` (`platform/database/postgres-errors.ts`) is a backstop for the presenter slot.
- `live/live.module.ts`: Drizzle when `config.database.configured`, otherwise the in-memory twins, one
  instance per port pair.
- `test/support/live-contract-suite.ts`, run by an in-memory spec and by a Postgres spec, so mock parity
  is enforced.

**Tests:**
- `test/integration/live-postgres.spec.ts`:
  - every CHECK rejects its violation, by constraint name;
  - no foreign key leaves Live's tables (`pg_constraint`);
  - `state_version` rises by exactly 1 per change;
  - End of 3,000 pending hands in one statement, within a time budget.
- `test/integration/live-migrations.spec.ts`: 0012 → 0013 upgrades an existing database, and no
  existing table changes (a `pg_catalog` snapshot comparison).
- **Migration drift:** `drizzle-kit generate` reports no schema change after 0013.

**Acceptance:**
- `npm run verify` green, with `TEST_DATABASE_URL` set.
- The contract suite passes on both adapters.

### Commit D — Convergence and Live's contracts

**Files:** `live/application/live-reconciler.ts`, `protect-live-sessions.ts`, `live-audience.service.ts`,
`live-sessions.reader.ts`; `live/contracts/live-sessions.ts`, `live-audience.ts`, `index.ts`;
`live/live.module.ts` (imports, exports).

**Behaviour** (design §11). Every timer is `setInterval` with `unref()`. Ticks are single-flight and
exposed for tests. A run happens at bootstrap.

**Room sweep, every 30 s:**
1. Page the live sessions, 100 at a time; one `listRooms()`. **If any page fails, abort the whole sweep
   and delete nothing** (audit D23): an incomplete set would make a live room look orphaned.
2. A live session whose current room is missing → `ensureRoom`, then re-check.
3. Empty rooms → `markEmpty`. Empty for longer than `IDLE_END_SECONDS` → `endBySystem('idle')`.
4. A name matching `isMediaRoomName` that is not the current room of any live session and is older than
   `ORPHAN_GRACE_SECONDS` → `endRoom`.

**Participant sweep, every 60 s per session, staggered:**
1. One `listParticipants`.
2. `heads([communityId])`: absent, or `runningLiveContinues` false → `endBySystem('community_closed')`.
3. Standing, in chunks of 1,000 (`LiveStanding.ofAccounts`), for:
   - the connected standard identities;
   - **every holder of a granted request (≤ 4) and of the open presenter grant (≤ 1), connected or not**
     (audit D21).
4. For each identity:
   - **not eligible to stay** → `expireIneligible`, which publishes `live.speaker.expired` and
     `live.screen_share.stopped {reason: 'ineligible'}`. Then, if connected,
     `removeParticipant(…, {revokeTokensIssuedBefore: now})`, and add it to the watch;
   - **a presenter who is no longer a moderator** → the grant closes as `ineligible`;
   - **a connected identity whose observed set differs from the desired set** →
     `updateCapabilities(desired)`, and add it to the watch. A *violation* is counted only when an
     earlier correction of that identity **reported `applied`** and it is observed again, inside the
     window, not eligible to stay or holding a source it is not entitled to publish (audit D22).
     - A failed or `not_connected` push is not a violation.
     - A set below the desired one never is.
     - The second violation → the media reset.
5. **Any dependency unreachable → skip this session's tick. Never eject on unknown state.** That
   includes Communities, `permittedAmong`, identity's `live.speak` lookup (`withPermission`), Postgres
   and the provider (audit D23).

**Targeted watch, every 10 s.** It covers:
- identities whose floor or presenter grant closed within `ENFORCEMENT_WATCH_SECONDS`, from
  `floorClosedSince` and `closedSince`;
- the in-memory set: identities the sweep corrected, or whose last push did not report `applied`.

Each gets the per-identity step above, through `getParticipant`.

**Media reset** (design §11.4), at the second violation inside the window:
1. `bumpEpoch` (compare-and-set) with the `reset_media` row;
2. `ensureRoom(new)`;
3. `endRoom(old)`;
4. the audit `live.session.media_reset`, with a null actor.

A capability observed *below* its desired set is never a violation.

**Observations.** The last observation per (session, identity) is kept in memory for the hands page. It
is bounded, and dropped when the session ends.

**`ProtectLiveSessions`** (audit D17). It subscribes to `communities.member.removed`,
`.capability.revoked`, `.ownership.transferred`, `.community.locked` and `.unlocked`. Handling is
detached and chained per community. It finds the community's live session and runs the per-identity step:

| Event | Identities |
| --- | --- |
| `member.removed`, `capability.revoked` | the user |
| `ownership.transferred` | `fromUserId` and `toUserId` |

For a lock or unlock it runs the per-session step. A lost event costs at most one sweep period.

**`LiveAudienceService`** and **`LiveSessionsReader`** implement §2.2.

**Tests** (`live-reconciler.spec.ts`, `protect-live-sessions.spec.ts`, `live-audience.spec.ts`), using
the fake's scripted observations and a controlled clock:
- **Rooms:**
  - a missing room is re-created, then re-checked;
  - `empty_since` is set and cleared, and the session ends `idle` after the bound;
  - an orphan is deleted only after the grace, never during a start in flight;
  - another deployment's prefix is never touched.
- **Ineligible participants:**
  - a removed member is removed, with the hand expired and the presenter grant closed;
  - a suspended account is removed;
  - a member who loses `communities.read` is removed, with eligibility from `permittedAmong` and never a
    rule copied into Live;
  - a LOCKED community's member is **not** removed;
  - an unmapped status ejects nobody.
- **Capabilities and the reset:**
  - a wrong permission is corrected with the full set;
  - the 12-minute refreshed-token regression;
  - violations are counted and the window extended;
  - the second violation → exactly one reset (epoch + 1, the new room ensured, the old one ended, the
    audit with a null actor);
  - a capability below its desired set → no reset.
- **Failures:**
  - a lost Communities event is covered within one sweep, including for a **disconnected** holder of a
    floor or of the presenter grant (D21);
  - `permittedAmong` rejecting → the tick is skipped and nobody is ejected;
  - the `live.speak` lookup rejecting → skipped, and nobody is demoted;
  - a Postgres failure midway through paging the live sessions → no orphan is deleted;
  - a provider outage → skipped;
  - a revoke during an outage, then recovery with the speaker still publishing → one corrective push, and
    **no reset** (D22);
  - with the disabled provider, every tick is skipped, and the log line appears once, not per tick.
- **Restart:** module A starts a session and grants a speaker, and is discarded. Module B on the same
  database runs its boot pass, and its `/join` issues the microphone with no in-memory state.
- **Contracts:** `LIVE_AUDIENCE` against `permittedAmong`'s answers, the host's inclusion and exclusion,
  and paging; `LIVE_SESSIONS.describe`.

### Commit E — Realtime hints

**Files:**
- `realtime/application/live-relay.ts` (`LiveRealtimeRelay`);
- `realtime/application/envelopes.ts` (three live frames);
- `realtime/realtime.module.ts` (imports `LiveModule`);
- `test/fixtures/realtime-frames/live/*.json` and its README note;
- the `envelopes.spec.ts` fixture reading.

**Behaviour** (design §16; hub §16):

| Events | Frames |
| --- | --- |
| `live.session.started`, `.ended` | to the community's ACTIVE members online on this instance (`onlineAudience` over `COMMUNITY_MEMBERSHIP.members`), filtered by `LIVE_AUDIENCE.participantsAmong` in chunks of 1,000 |
| Every speaker and screen-share event | `live.session.changed`: to the affected user at once when online; to online moderators (`LIVE_AUDIENCE.moderators`) at most once per 250 ms per session, through a transient trailing timer carrying the latest `stateVersion`; **nothing to listeners** |

- Delivery is detached from the publisher and chained per session.
- Nothing happens when nobody is connected.
- Nothing is stored.

**Tests** (`live-relay.spec.ts`):
- frames are built field by field, with ids only;
- the affected user gets the frame immediately;
- moderators are coalesced: 3,000 events → ≤ 4 frames per second per moderator;
- start and end frames go only to eligible online accounts, with ⌈online/1000⌉ probes;
- nothing is sent when nobody is connected;
- order is kept per session;
- a removed member gets no start frame.

**Architecture:** realtime reaches Live only through `live/contracts` or `live.module.ts`; Live never
reaches realtime.

**Flutter:** `flutter test` is run unchanged and stays green. That the app's fixture test ignores `live/`
is asserted by running it.

### Commit F — Adversarial, concurrency, scale and security suites

**Postgres races** (`live-postgres.spec.ts`, `live-races.spec.ts`). The techniques come from
`communities-postgres.spec.ts` (several repository instances, `statement_timeout`, deadlock retries
asserted 0, `whileHolding` plus `lockWaiters`) and `community-chat-postgres.spec.ts` (a pause gate between
the permit and the write, 50-round ordering). Every row of audit §14:

| Race | Asserted outcome |
| --- | --- |
| 20 concurrent starts | one live row; the same id for every caller; the losers' rooms ended |
| two concurrent joins | two tokens; zero writes (statement spy) |
| grant + removal | cases A and B, and the 50-round ordering |
| grant + End; raise + End; claim + End; join + End | nothing open in an ended session |
| raise + removal | as grant + removal |
| lock + start | as audit §14 |
| removal + join | as audit §14 |
| grant-basis revocation + moderation | the audit carries the permit it acted on |
| 10 concurrent grants | exactly 4 |
| 2 presenter claims | exactly 1 |
| 20 raises by one user | one row, one event |
| revoke + yield; lower + grant | one winner each |

**Scale** (`live-scale.spec.ts`):
- **Statement budgets** from a query spy: join, raise, grant, end, current and the hands page are
  constant whether a session has 3 pending hands or 3,000; `/join` writes nothing; no `count(` without a
  `LIMIT` on a request path.
- **`EXPLAIN`**, index-served over a churned fixture of many ended sessions and many terminal requests:
  - the partial unique indexes;
  - the pending keyset;
  - the granted partial;
  - the reconciler's live page;
  - End's set-based expiry.
- **Timings** are recorded without assertions (`SCALE_REPORT`), so P8 has a baseline.

**Security:**
- the join token's exact claim set, decoded through the fake's recorded grant and the adapter's existing
  spec: one room, the user id, the directory name, explicit sources, no data, no admin grants, TTL 120;
- no token or secret in any log line, event, frame or audit entry, checked by scanning captures for
  JWT-shaped strings and the fake token pattern;
- one indistinguishable 404 for unknown and not-visible on **every** route, including the
  community-scoped start and current routes: a non-member never learns whether a session runs;
- `DELETE …/hand` reveals nothing to a caller who holds no open hand and may not see the session;
- the provider binding (D19): a deployment without `LIVE_MEDIA_PROVIDER=livekit` never reaches the
  adapter, and Start answers 503 with nothing stored.

**Mutation checks** (§4). Each mutant is applied to a scratch copy, the named tests are run, and the kill
is recorded.

### Commit G — Documentation and the architecture gate

**Architecture specs:**
- `live-boundaries.spec.ts`: Live reaches Communities only through contracts or the module file; Live
  never reaches messaging, realtime, notifications, academic, operations or attendance; exports are
  `LIVE_AUDIENCE` and `LIVE_SESSIONS` only.
- `communities-boundaries.spec.ts`: Communities never reaches Live (unchanged, still asserted).
- `realtime-boundaries.spec.ts`: realtime reaches Live only through contracts.
- `rules-match.spec.ts`: still non-vacuous.

**Documents.** Each gets a P6 landed note, following the P1 and P5 precedent:

| Document | Change |
| --- | --- |
| `live.md` | the P6 note (what landed, and what moved to the LiveKit-integration phase); refreshed citations |
| ADR 0019 | a dated amendment note, following its 2026-09-24 note: decision 7's pinned configuration and the contract suite "required (P6)" move to the LiveKit-integration phase (the brief); real media binds only on opt-in (audit D19). The ADR's text is not edited |
| `attendance.md` | its P6 prerequisite, the real-server contract suite, moves with it |
| hub §25 | the P6 status row (scope as built); P7's row split into the LiveKit-integration phase and the Flutter live phase, per audit §2 |
| `communities.md` | `permittedAmong` and `remain` landed |
| `realtime.md` | the live frames |
| `authorization.md` | the host-only rule retired |
| `events.md` | the live catalogue |
| `module-boundaries.md` | the live section |
| `open-questions.md` | Q1's line revised by ADR 0017; Q56's pending confirmation restated |
| `persistence.md` | the live tables |
| `backend/README.md` | the live routes and `LIVE_*` variables |
| `README.md` | test counts |

**Acceptance:** §5.

---

## 4. Mutation checks

Each mutant is a type-correct, single-site change, applied to a scratch copy. It must make at least one
named test fail. Results are recorded in the P6 landed note in `live.md`.

| # | Mutant | Must be killed by |
| --- | --- | --- |
| M1 | `LiveAccess` drops the host fallback | the host moderates their own session |
| M2 | `LiveAccess` accepts a join permit as moderator | a member cannot moderate |
| M3 | Start inserts before `ensureRoom` | provider outage → 503 with nothing stored |
| M4 | End's update loses `WHERE state = 'live'` | a repeat End publishes nothing |
| M5 | End does not expire open requests | End expires every hand |
| M6 | Grant skips the target eligibility check | `target_not_eligible` for a removed member |
| M7 | Grant skips the cap | exactly 4 granted |
| M8 | Grant skips `target_is_host` | a delegate cannot act on the host's request |
| M9 | Join asks only identity's `live.join` | a non-member → 404 |
| M10 | `capabilitiesFor` gives listeners `canPublishData` | the capabilities matrix |
| M11 | Presenter claim skips `live.speak` | `presenter_not_permitted` |
| M12 | `permittedAmong` allows the oversight basis | never permits by oversight |
| M13 | `community.live.remain`'s gate is `liveJoinOpen` | an unmapped status ejects nobody |
| M14 | Raise skips the raise permit | a non-member cannot raise |
| M15 | The reconciler treats a `permittedAmong` rejection as `[]` | an unreachable dependency ejects nobody |
| M16 | Lower transitions only from the state it read | lower racing a grant yields |
| M17 | `ProtectLiveSessions` ignores `member.removed` | eviction at once through the event path |
| M18 | Identity's rule list keeps `host-only-moderation` | a delegate moderates |
| M19 | The factory binds the LiveKit adapter without the opt-in | the binding spec; Start → 503 with nothing stored |
| M20 | The participant sweep checks only connected identities | a disconnected holder's floor expires `ineligible` (D21) |
| M21 | A failed push counts as a violation | no reset after an outage (D22) |
| M22 | Start skips the permit re-ask after `ensureRoom` | a lock committing during `ensureRoom` → 412, and the ensured room ended (D20) |

---

## 5. Acceptance criteria (all P6)

1. **Gates.**
   - `npm run verify` is green: format, lint, typecheck, `depcruise` with 0 violations, and every Jest
     suite.
   - `TEST_DATABASE_URL` is set, and the output shows **no `[skip]`**.
   - `drizzle-kit generate` shows no drift.
   - `flutter test` and `flutter analyze` are green and **unchanged**: no Flutter file changes.
2. **Behaviour.** Every row of audit §11 (routes and refusals), §12 (events and frames) and §14 (races)
   is asserted by a test named for it.
3. **Security.**
   - A token is issued only after the community permit on the stored `communityId`.
   - An all-permission principal without standing cannot moderate, end or present.
   - No `ownerUserId` is passed.
   - `PROVISIONAL_POLICY_RULES` is `[]`.
   - No token or secret appears in any log, event, frame or audit entry.
4. **Architecture.**
   - Live reaches Communities only through contracts.
   - Communities never reaches Live.
   - Realtime reaches Live only through contracts.
   - One file imports LiveKit.
   - Exports are contract tokens.
   - No `forwardRef`.
   - No foreign key leaves Live's tables.
5. **Durability.** The restart test passes. An ended session is never resurrected.
6. **Mutation.** M1–M22 are all killed, and the results are recorded.
7. **No skipped tests; no TODOs replacing implementation;** no commented-out code.
8. **Documents.** They are updated as listed in commit G. The audit's §17 items are restated in the P6
   report.

---

## 6. Explicit non-goals

**Flutter:**
- no Flutter change at all;
- no live UI;
- no `livekit_client`;
- no microphone, camera, speaker or screen-share UI;
- no `LiveRepository`;
- no frame parsing. These belong to the Flutter live phase (the design's P7) and the media phase (P7b).

**Real LiveKit** (the LiveKit-integration phase):
- no pinned server configuration;
- no contract suite against a real server;
- no `/rtc/validate` self-check;
- no adapter change;
- no new SDK;
- real media not enabled: P6 binds the adapter only on explicit opt-in (D19).

**No change to identity's seeded catalogue text.** A separate identity-data migration is proposed for
approval (audit §17.12).

**Deferred by policy:**

| Not built | Why |
| --- | --- |
| Attendance: `LIVE_PRESENCE`, snapshots, "present" thresholds | P9, HELD |
| Notifications for live facts | Q67 |
| Direct member lookup | the brief |
| Academic Progress or Promotion changes | the brief |
| An HTTP participants roster, `participant.joined`/`left` events, or promotion without a raised hand | Q59, ADR 0021, Q62 |
| Scheduled sessions (Q12); a large-event broadcast (Q58); a waitlist (Q57) | their questions |
| A moderator kick or re-entry; a moderator-chosen media reset | Q64, P12 |
| Delegated or audio screen share | Q56, P12 |
| Hidden listeners | Q59 |
| Webhooks | P12 |

**Deferred to later phases:**
- no reconciler lease and no outbox (P11);
- no metrics backend: structured logs only (audit D15);
- no capacity above the configured default, until P8 measures;
- no load test (P8).
