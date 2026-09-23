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
    academic/      programs, levels, curricula
    operations/    halaqat, schedules, enrolment, attendance
    assignments/   tasks, submissions, grading
    messaging/     direct, group and channel conversations
    live/          realtime audio rooms, raise-hand queue, moderation
    files/         upload policy, storage keys, signed access
    notifications/ delivery of events to people
    automation/    scheduled and triggered actions
    reporting/     read models, KPIs, Owner Command Center widgets
```

Depth of implementation varies deliberately:

| Module | State |
| --- | --- |
| `identity` | **Identity & Access V1**: authentication, rotating refresh sessions, multi-device, provisioning, audit, rate limiting. On Postgres, tested |
| `live` | Implemented end to end against the RTC port; in-memory persistence |
| `files` | Policy + storage port + local adapter implemented; upload endpoint deferred |
| the other eight | Contracts and a Nest module only — deliberately empty |

The eight near-empty modules exist so that the boundary is decided before the
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

---

## 6. What is intentionally NOT here

Named, so that absence reads as a decision rather than an oversight:

- **No chat UI and no 2500-person room UI.** Explicitly out of scope for this
  milestone. The contracts they will need exist; the screens do not.
- **Postgres adapters only where there is code.** Identity and audit are on
  Postgres. `live` is still in memory. The eight contract-only modules have no
  tables. See [persistence.md](persistence.md).
- **No seeded accounts and no default credentials.** The first owner is created
  on the server with a CLI that reads the password from stdin. Q2.
- **No confirmed role→permission matrix.** What a Supervisor may actually do is
  an institutional decision. The matrix in force is provisional, in one file,
  and in the database. Q1.
- **No messaging implementation.** Only the boundary. See
  [messaging.md](messaging.md).
- **No load testing.** The design is *arranged to be* load-testable; it has not
  been load-tested. See [realtime.md](realtime.md), "What is proven and what is
  not."

---

## 7. The Flutter application

The existing prototype in `app/` is untouched by this milestone. It was
inspected first, and it is already organized the way this architecture wants:

`app/lib/data/repositories/repositories.dart` declares abstract repository
interfaces, and the screens depend only on those. The in-memory prototype
implementations are swapped for HTTP-backed ones by writing new classes against
the same interfaces — no screen changes. That file is the integration seam, and
it is where the backend will attach.

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
- [realtime.md](realtime.md) — the 2500-participant design
- [messaging.md](messaging.md) — the messaging boundary
- [storage.md](storage.md) — files and binaries
- [persistence.md](persistence.md) — database strategy
- [observability.md](observability.md) — logging, audit, health, metrics
- [open-questions.md](open-questions.md) — what we deliberately did not decide
- [decisions/](decisions/) — the ADRs behind all of the above
