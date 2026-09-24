# Architecture Decision Records

One file per decision that is expensive to reverse.

**Format.** Context → Decision → Consequences → Alternatives considered. The
last section is the one that matters in two years: it is the record of what was
already thought about, so a decision is only reopened with new information
rather than with an argument that was already had.

**Status** is one of `Proposed`, `Accepted`, `Superseded by NNNN`, or `Deprecated`. An ADR
is never edited to change its decision — a new one supersedes it. The record is
the history, not the current state.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-backend-stack.md) | TypeScript and NestJS for the backend | Accepted |
| [0002](0002-modular-monolith.md) | Modular monolith, not microservices | Accepted |
| [0003](0003-rtc-provider-abstraction.md) | Abstract the RTC provider behind a port | Accepted |
| [0004](0004-storage-provider-abstraction.md) | Abstract binary storage behind a port | Accepted |
| [0005](0005-authorization-architecture.md) | Centralized permission + policy authorization | Accepted |
| [0006](0006-event-architecture.md) | In-process domain events, outbox-ready | Accepted |
| [0007](0007-messaging-architecture.md) | One conversation model; references, not payloads | Accepted |
| [0008](0008-drizzle-over-prisma.md) | Drizzle ORM rather than Prisma | Accepted |
| [0009](0009-executable-architecture-rules.md) | Enforce boundaries with dependency-cruiser in CI | Accepted |
| [0010](0010-stateful-sessions-and-rotating-refresh-tokens.md) | Stateful sessions, checked per request, with rotating refresh tokens | Accepted |
| [0011](0011-messaging-v1.md) | Messaging V1: server-ordered, idempotent, membership-first | Accepted |
| [0012](0012-realtime-messaging-transport.md) | Realtime messaging: plain WebSocket, membership decided per event | Accepted |
| [0013](0013-notifications-v1.md) | Notifications V1: a stored inbox, idempotent by the database, delivered by subscribers | Accepted |
| [0014](0014-academic-core-v1.md) | Academic Core V1: academic owns the structure and who is in it | Accepted |
| 0015 | *Reserved* for the academic structure change: the ADR superseding the parts of 0014 that the owner's answers change ([academic-reconciliation.md §13](../academic-reconciliation.md#13-minimal-recommended-changes-before-the-next-milestone)). Not yet written | — |
| [0016](0016-communities-module.md) | Communities: a new module owns communities, membership, invitation links and lifecycle | Accepted |
| [0017](0017-community-scoped-authorization.md) | Community-scoped authorization: identity ceilings AND community standing; delegated capabilities; host-only moderation retired | Accepted |
| [0018](0018-community-chat-projection.md) | Community chat: messaging keeps a named, versioned projection of community membership | Accepted |
| [0019](0019-community-scoped-live-sessions.md) | Community-scoped live sessions: Postgres truth, level-triggered LiveKit convergence, a presenter slot, narrow RTC ports | Accepted |
| [0020](0020-attendance-snapshots.md) | Attendance snapshots are observations owned by a new attendance module (implementation held) | Accepted (implementation held) |
| [0021](0021-cross-cutting-rules-for-new-modules.md) | Cross-cutting rules for the new modules: events in contracts, journals, durability classes, the realtime transport matrix, protocol v1 growth, `FailureKind 'unavailable'`, executable guards | Accepted |
| [0022](0022-community-chat-delivery-check.md) | Community chat: every recipient page is checked against Communities, and a divergence rebuilds the projection (supersedes 0018 in part) | Proposed (implemented; awaiting acceptance) |

> **`Proposed`** (added 2026-09-23): a design under review, with nothing
> implemented. It becomes `Accepted` when the user accepts it (dated in the
> ADR), or it is withdrawn. 0016–0021 were accepted by the user on
> 2026-09-23. Acceptance does not by itself start implementation: 0016–0019
> and 0021 are implemented in phases, and 0020's implementation is held until
> the attendance policy questions are answered (the Q40 ruling in
> [0016](0016-communities-module.md)).
>
> **0022 is the one `Proposed` record that is implemented.** Review of P4
> found that 0018's decision 9 lets delivery trust a stale projection after
> Communities is restored from a backup. The P4 brief's §19 forbids that.
> The fix therefore landed with P4's review fixes and waits for the user's
> acceptance. Rejecting it restores decision 9, a small code change.

**0015 is reserved.** The academic reconciliation names ADR 0015 for its
structure change (`academic-reconciliation.md:410`, `:490`, `:506`), which
waits on the owner's answers to Q35 and Q36. The communities, live and
attendance package therefore starts at 0016 rather than renumbering that
reservation.

**0016–0021 are one package**, described in
[communities-live-attendance.md](../communities-live-attendance.md). If
accepted, they amend or partly supersede 0003, 0005, 0006, 0009, 0011 and
0012; each new ADR says exactly which part. Those ADRs are not edited and stay
`Accepted`: a partial supersession is recorded in the ADR that makes it.
