# Architecture Overview

**Status:** Foundation V1. Some of what is described here is implemented and
tested; some is a designed-but-unbuilt slot. Every section says which.

---

## 1. What this system is

A platform for running an educational institution: people, programs, halaqat,
sessions, attendance, assignments, progress, certificates, messaging, live audio
classrooms, reporting — and modules that do not exist yet.

The defining constraint is not any single feature. It is that the feature list
will keep growing for years, and that **adding a module must not require
rewriting the existing ones**. Everything below follows from that.

The second defining constraint is a hard technical one: a live audio room must
hold **~2500 concurrent participants**, one speaking teacher, the rest
listening, with a raise-hand queue and teacher-granted speaking permission. That
number shapes the realtime design (see [realtime.md](realtime.md)) and nothing
else.

---

## 2. Shape: a modular monolith

One deployable process. Hard internal boundaries. Modules that can be lifted out
into separate services later, if and when a real scaling reason appears.

See [decisions/0002-modular-monolith.md](decisions/0002-modular-monolith.md) for
why this rather than microservices.

```
backend/src/
  shared/        the shared kernel — Id, Result, Clock, DomainEvent, Principal
  platform/      technical substrate — config, logging, HTTP, events, audit, health
  modules/       the business modules
    identity/      users, roles, permissions, policies, authentication
    people/        students, teachers, guardians, staff profiles
    academic/      sections, programs, halaqat; who is enrolled, who teaches
    operations/    schedules, sessions, attendance
    assignments/   tasks, submissions, grading
    messaging/     direct, group and channel conversations
    live/          realtime audio rooms, raise-hand queue, moderation
    files/         upload policy, storage keys, signed access
    notifications/ each person's inbox: what they were told, read or not; push
    realtime/      messaging, notification and community events to connected clients, over WebSocket
    automation/    scheduled and triggered actions
    reporting/     read models, KPIs, Owner Command Center widgets
```

Depth of implementation varies deliberately:

| Module | State |
| --- | --- |
| `identity` | **Identity & Access V1**: authentication, rotating refresh sessions, multi-device, provisioning, audit, rate limiting. On Postgres, tested |
| `live` | Implemented end to end against the RTC port; in-memory persistence |
| `files` | **Messaging V1**: allow-listed, verified uploads; signed links; local adapter with its transfer routes. On Postgres, tested |
| `messaging` | **Messaging V1**: DMs, groups, channels; server-ordered, idempotent sends; read state; keyset pages; membership-first authorization. **Community chats (P4)**: a community's chat is an ordinary conversation whose membership Communities decides, on every request ([community-chat.md](community-chat.md)). On Postgres, tested |
| `notifications` | **Notifications V1**: a persistent inbox fed by messaging's facts; idempotent by a database constraint; read state, capped unread count, keyset pages; per-channel preferences; device registration; push behind a provider port (logging adapter — no provider chosen, Q24). On Postgres, tested |
| `realtime` | **Realtime Messaging V1**: authenticated WebSocket at `/realtime`; messaging events to current members' connections, per event; each person's new notifications and reads to their own connections; multi-device; heartbeat; limits. **Community frames (P5)**: a community's lock and unlock to its members online, and a person's own addition, removal and access change to them, as ids-only hints asked of Communities at delivery time; fan-out bounded by the accounts online, not by members (gate G1) ([realtime.md Part C](realtime.md#part-c--communities-in-real-time)). Single instance, tested on Postgres |
| `academic` | **Academic Core V1**: sections → programs → halaqat, seeded from the printed institution profile (provisional: the owner's later description differs and is under [reconciliation](academic-reconciliation.md)); dated enrollments and teacher assignments with history; one-active invariants in the database; resource-level access (a teacher's roster through their assignment); `ACADEMIC_RELATIONSHIPS` for later modules ([academic.md](academic.md)). On Postgres, tested |
| `communities` | **Communities core (P2) and delegation (P3)**: persistent spaces (the brief's "groups") and who belongs — membership stints with history, invitation links (only the token's SHA-256 is stored), OPEN/LOCKED; capabilities the owner delegates to members one grant at a time, revocation, and ownership transfer; one evaluator behind `COMMUNITY_AUTHORIZATION` (ceiling AND membership, ownership, a grant or oversight AND lifecycle); `COMMUNITY_MEMBERSHIP`, `COMMUNITY_CAPABILITY_HOLDERS` and `COMMUNITY_DIRECTORY` for later consumers ([communities.md](communities.md)). On Postgres, tested at 30,000 and 100,000 members |
| the other five | Contracts and a Nest module only — deliberately empty |

> **Proposed change:** see
> [communities-live-attendance.md](communities-live-attendance.md) (approved
> design, [ADR 0016](decisions/0016-communities-module.md) Accepted). Two new
> modules would join this map. `communities` is what the brief calls
> "groups"; the code name is Community because "group" already means
> messaging's `GROUP` conversation type, and is used for Tahajji's «مجموعة»
> in
> [Q36](open-questions.md#q36--tahajji-دورة-التهجي-وإعداد-المعلمات-مدينة-التهجي-and-the-40-groups).
> `attendance` would own live-session snapshots; its implementation is held
> ([ADR 0020](decisions/0020-attendance-snapshots.md)). `live` would become
> community-scoped ([ADR 0019](decisions/0019-community-scoped-live-sessions.md)).
> [30,000 community members is not 30,000 live participants](communities-live-attendance.md#13-30000-members-is-not-30000-live-participants):
> a live session has its own measured cap, and a self-hosted LiveKit room
> must fit on one node. **Update (2026-09-23):** `communities` exists as of
> P2 (the row above); `attendance` does not, and stays held.

The near-empty modules exist so that the boundary is decided before the
code arrives, not after. An empty `contracts/index.ts` is a cheap commitment; a
module retrofitted into a boundary is not.

---

## 3. Layers inside a module

```
        api/            HTTP edge. Controllers, DTOs, guards. No business logic.
          ↓
        application/    Use cases. Orchestration, authorization, transactions.
          ↓
        domain/         Entities, value objects, invariants, PORTS. Zero dependencies.
          ↑
        infrastructure/ Adapters implementing the domain's ports.

        contracts/      The module's ONLY public surface. Other modules see this
                        and nothing else.
```

Two properties are worth stating plainly, because they are what the whole
structure buys:

**The domain imports nothing.** Not Nest, not LiveKit, not Drizzle, not Node's
own standard library. It is enforced, not aspirational — see
`.dependency-cruiser.cjs`, rule `domain-is-dependency-free`. Anything the domain
needs from the world is an interface it declares (a *port*) and infrastructure
implements (an *adapter*).

**Direction of dependency is inward.** `api` knows `application`; `application`
knows `domain`; `infrastructure` knows `domain`. Nothing points the other way.
This is what makes the domain testable without a database, a broker, or a
network.

The full rule set, with what each one prevents, is in
[dependency-rules.md](dependency-rules.md).

---

## 4. How modules talk to each other

Three mechanisms, in order of preference:

1. **Events** — the default for "something happened, others may care."
   `AttendanceRecorded` does not know that notifications exist. See
   [events.md](events.md).
2. **Contracts** — a synchronous call through the other module's `contracts/`
   directory, when the caller genuinely needs an answer now. `live` asks
   `identity` "may this principal moderate?" and cannot proceed without knowing.
3. **Read models** — `reporting` builds its own projections rather than
   querying eight modules' tables at request time.

And one anti-mechanism: **no module reads another module's database tables.**
Ever. That is the single rule that makes later extraction possible, and the
single rule that is most tempting to break under deadline.

---

## 5. External systems, and where they are allowed to exist

Every external dependency sits behind a port, in exactly one adapter file:

| Concern | Port (domain) | Adapter (infrastructure) |
| --- | --- | --- |
| Realtime audio | `RtcProvider` | `LiveKitRtcProvider`, `FakeRtcProvider` |
| Binary storage | `StorageProvider` | `LocalStorageProvider` (S3 adapter later) |
| Push delivery | `PushProvider` | `LoggingPushProvider` (APNs / FCM when chosen, Q24) |
| Accounts | `UserRepository` | `DrizzleUserRepository`, `InMemoryUserRepository` |
| Sessions | `AuthSessionRepository` | `DrizzleAuthSessionRepository`, in-memory |
| Role matrix | `RoleCatalog` | `DrizzleRoleCatalog`, in-memory (provisional) |
| Refresh secrets | `SecureTokenGenerator` | `CryptoSecureTokenGenerator` |
| Rate limits | `RateLimiter` | `InMemoryRateLimiter` (Redis later) |
| Password hashing | `PasswordHasher` | `ScryptPasswordHasher` |
| Token issuing | `TokenIssuer` | `JwtTokenIssuer` |
| Time | `Clock` | `SystemClock`, `FixedClock` |
| Ids | `IdGenerator` | `UuidGenerator` |
| Audit | `AuditLog` | `DrizzleAuditLog`, `LoggingAuditLog` |
| Events | `EventPublisher` | `InProcessEventBus` |

`livekit-server-sdk` is imported by exactly one file in the repository. So is
every other vendor SDK. This is checked by
`application-has-no-vendor-sdks` and `domain-is-dependency-free`.

> **Resolved in Phase 0 (2026-09-23)** for LiveKit: the rule
> `livekit-sdk-only-in-the-live-adapter` now confines every LiveKit package
> to `live/infrastructure/`, `application-has-no-vendor-sdks` matches resolved
> paths, and `live-boundaries.spec.ts` and `rules-match.spec.ts` prove both can
> fire ([dependency-rules.md](dependency-rules.md#livekit-sdk-only-in-the-live-adapter)).
> The second sentence remains inaccurate as written: the other SDKs are
> confined to infrastructure layers, not to one file each.
>
> **Correction (2026-09-23):** the first sentence is true today by search
> (`live/infrastructure/livekit-rtc-provider.ts:2`). The second is false:
> other SDKs that `application-has-no-vendor-sdks` lists are imported by
> several files (`drizzle-orm` 18, `express` 7, `nestjs-pino` 3, `pg` 2).
> The claim that it is checked is not true either.
> `domain-is-dependency-free` covers `domain/` only.
> `application-has-no-vendor-sdks` never fires, because its pattern is
> anchored at the package name while dependency-cruiser matches
> `node_modules/…` paths (`backend/.dependency-cruiser.cjs:88`). Apart
> from three module-specific specs, nothing stops an `api/`,
> `application/`, `infrastructure/` or `platform/` file from importing
> LiveKit; see
> [dependency-rules.md](dependency-rules.md#application-has-no-vendor-sdks).
> The fix is Phase 0 of the proposed design
> ([communities-live-attendance.md §25.1](communities-live-attendance.md#251-phase-0-corrections)).

---

## 6. What is intentionally NOT here

Named, so that absence reads as a decision rather than an oversight:

- **No 2500-person room UI.** Out of scope. Messaging V1 built the chat screens
  (list, conversation, composer); live rooms are the next milestone's.
- **Postgres adapters only where there is code.** Identity, audit, files,
  messaging, notifications, academic and communities are on Postgres. `live`
  is still in memory. The contract-only
  modules have no tables. See [persistence.md](persistence.md).
- **No seeded accounts and no default credentials.** The first owner is created
  on the server with a CLI that reads the password from stdin. Q2.
- **No confirmed role→permission matrix.** What a Supervisor may actually do is
  an institutional decision. The matrix in force is provisional, in one file,
  and in the database. Q1.
- **No push provider, and realtime on one instance.** A connected app
  receives messages and notifications over the realtime WebSocket (ADR 0012);
  an app that is not connected finds its notifications in the inbox when it
  next opens. Push is built up to a provider port whose only adapter logs —
  no Firebase, APNs or web-push SDK is installed until a provider is chosen
  and can be verified on devices (Q24, ADR 0013). Several API instances need
  a broker-backed event bus first. See [realtime.md](realtime.md) Part M and
  [notifications.md](notifications.md).
- **No load testing.** The design is *arranged to be* load-testable; it has not
  been load-tested. See [realtime.md](realtime.md), "What is proven and what is
  not."

---

## 7. The Flutter application

The prototype in `app/` is organized the way this architecture wants:
`app/lib/data/repositories/repositories.dart` declares abstract repository
interfaces, and the screens depend only on those.

Messaging V1 used that seam for the first time. `MessagingRepository` and
`AuthRepository` have HTTP implementations, selected when the app is built with
`--dart-define=API_BASE_URL=…`; without it the in-memory implementations run,
so the GitHub Pages demo is unchanged. The rest of the prototype's screens were
not touched beyond one added entry in the profile.

Realtime Messaging V1 added the live connection the same way: a
`RealtimeClient` abstraction, a WebSocket implementation when a backend is
configured and a disabled one otherwise. No screen touches a socket; the
messaging state listens to the client's events and connection states.

Notifications V1 added `NotificationsRepository` (HTTP and in-memory), the
notification center and its settings, one unread count behind every badge,
and a `PushTokenSource` seam with no push SDK behind it yet. The only change
to Home, Programs and Profile is the badge on their existing bells and row.

P5 added a read-only `CommunityRepository` (HTTP and in-memory), the
community frames, and three screens reached from Profile — the viewer's
communities, one community, and its roster for those allowed to see it —
showing only what the server's `me` block allows, never what a role
suggests; a community's chat opens as an ordinary conversation. Managing a
community from the app, and the `/invite` link, were deferred.

P5.1 added them. The server's `me` block now also lists the operations that
are not acts (`me.operations`: managing links and grants, handing over
ownership, leaving), so the app never works one out from a role or a
standing. The repository gained the management calls, and the community,
its roster and a new screen of invitation links offer lock and unlock,
leaving, a member's capabilities, handing over and removal, each one request
and read again once answered. An invitation link, `/invite#<token>`, works in
the web app: the token is taken out of the address before the app starts,
kept in memory only, and sent once when the viewer taps Join. Members are
added only through links: adding someone by account waits for a policy on
how a manager finds people, and mobile app links are not configured
([communities-live-attendance.md §25](communities-live-attendance.md#25-implementation-phases)).

The Flutter side holds **no secrets**. It never sees the LiveKit API secret; it
receives a short-lived, capability-scoped join token minted server-side.

---

## 8. Reading order

- [dependency-rules.md](dependency-rules.md) — the enforced rules
- [module-boundaries.md](module-boundaries.md) — each module's remit
- [authentication.md](authentication.md) — sign-in, tokens, passwords, provisioning
- [session-management.md](session-management.md) — devices, rotation, revocation
- [authorization.md](authorization.md) — how permission decisions are made
- [events.md](events.md) — how modules stay decoupled
- [realtime.md](realtime.md) — messaging and community facts in real time, and the 2500-participant audio design
- [messaging.md](messaging.md) — messaging V1: model, ordering, idempotency, authorization
- [notifications.md](notifications.md) — notifications V1: the inbox, deduplication, delivery, push, devices
- [storage.md](storage.md) — files and binaries
- [persistence.md](persistence.md) — database strategy
- [observability.md](observability.md) — logging, audit, health, metrics
- [open-questions.md](open-questions.md) — what we deliberately did not decide
- [decisions/](decisions/) — the ADRs behind all of the above
