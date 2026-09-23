# Architecture Decision Records

One file per decision that is expensive to reverse.

**Format.** Context → Decision → Consequences → Alternatives considered. The
last section is the one that matters in two years: it is the record of what was
already thought about, so a decision is only reopened with new information
rather than with an argument that was already had.

**Status** is one of `Accepted`, `Superseded by NNNN`, or `Deprecated`. An ADR
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
