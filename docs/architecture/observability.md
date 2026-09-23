# Observability & Audit

The brief asked to *prepare* for observability without building infrastructure
that is not needed yet. So: the seams exist and are wired; the backends are not
chosen.

---

## 1. Structured logging

`nestjs-pino`, configured once in `platform.module.ts`. JSON lines, not prose —
a log line is a record to be queried, and the moment the first production
incident happens nobody will be reading them by eye.

### Request correlation

```ts
genReqId: (req) => req.headers['x-request-id'] ?? randomUUID()
```

Every log line of one request shares an id, and the same id is returned on every
error response. So a user reporting "it failed at 14:32" yields one field to
search on, rather than a timestamp range.

An inbound `x-request-id` is honoured, which is what makes the id survive a
proxy or a future service boundary.

### Secret redaction

```ts
redact: {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.body.password',
    '*.jwtSecret',
    '*.apiSecret',
    '*.password',
    '*.token',
  ],
  censor: '[redacted]',
}
```

The wildcard paths are the important half. Explicit paths only protect the
shapes someone thought of; `*.apiSecret` catches the LiveKit secret wherever it
appears in a logged object — including inside a config dump added by someone
debugging, which is exactly how credentials reach log aggregators.

Redaction is a safety net, not a policy. The policy is that secrets are read
only by `platform/config` and passed only to the adapter that needs them.

---

## 2. Audit log

Events and audit entries are different things, and conflating them is the usual
mistake. See [events.md §6](events.md).

- An **event** is a fact offered to whoever cares. Losing one degrades a
  reaction.
- An **audit entry** records *who did what*, for accountability. It must not be
  lost, and nobody subscribes to it.

### The port

```ts
interface AuditEntry {
  readonly actorUserId: string | null;   // null only for system actions
  readonly action: string;               // 'live.speaker.granted'
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata?: Record<string, unknown>;
  readonly correlationId?: string;
}

interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}
```

It lives in the **shared kernel**, so any module can write an audit entry
without importing another module.

### The table

`audit_log`, owned by platform, with indexes on (actor, time) and (resource
type, resource id, time) — the two questions an audit log exists to answer.
Append-only by convention: no update or delete path exists in code.

### State: honest version

The table and its migration exist. The **adapter is still `LoggingAuditLog`**,
which writes to the structured log rather than to the table.

That is the most significant gap in this milestone. A structured log is
queryable and retained, so this is not nothing — but it is not an append-only
record with referential integrity either. `DrizzleAuditLog` is a small, known
piece of work, and it is listed as technical debt rather than described as done.

### What must eventually be audited

Role and permission changes; teacher assignment changes; attendance
modifications (which is why `AttendanceAmendment` requires a reason and an
amender in the contract); live-room moderation; administrative actions on
another person's record.

`ModerateSpeakerUseCase` already writes one, in the deliberate order: own state
→ provider → **audit** → event. Audit before event, because the record of the
act matters more than the reaction to it.

---

## 3. Health checks

`GET /health/live` and `GET /health/ready`, both `@PublicRoute()`.

The distinction is operational, not cosmetic:

- **live** — the process is running. Failing it should restart the pod.
- **ready** — the process can serve traffic. Failing it should remove the pod
  from the load balancer *without* restarting it.

Collapsing them produces a restart loop on a transient dependency outage: the
database blips, readiness fails, the orchestrator restarts a perfectly healthy
process, and the restart makes recovery slower.

`ready` currently reports process state only. It should check the database pool
and Redis before production — listed as debt.

---

## 4. Metrics — prepared, not built

No metrics backend is wired, deliberately: choosing one before there is
something to run it against is how projects acquire infrastructure they do not
operate.

What should be measured when one is chosen, in priority order:

**Realtime** — the numbers that determine whether the 2500-participant
requirement is actually met:
- participants per room, and the maximum observed
- join latency, p50/p95/p99
- token issue rate and failure rate
- active speakers, and speaker-grant latency
- speaker-queue depth

**HTTP** — request rate, error rate and duration by route, in that order.

**Domain** — authorization denials by permission (a spike means a broken
role matrix or an attack), login failure rate, event-subscriber failures.

`InProcessEventBus` already routes subscriber failures through an injected
`onHandlerError`, so that last one has a seam waiting for it.

---

## 5. Error responses

One shape, from `AllExceptionsFilter`:

```json
{ "error": { "code": "identity.permission_denied", "message": "...", "details": {} },
  "requestId": "..." }
```

Expected failures arrive already mapped: a use case returns `Result`, the
controller calls `unwrap()`, `FailureException` maps `FailureKind` → status via
one table. Adding a failure kind is a compile error until it is mapped, so
transport semantics cannot drift from domain semantics.

Anything else is a fault: logged in full with the request id, returned as an
opaque 500. Internal messages and stack traces never reach a client.

`describe()` in the filter exists so that a payload of an unexpected shape
cannot produce `"[object Object]"` in a response body — a small thing that is
invariably discovered in production rather than in review.

---

## 6. Deliberately deferred

- `DrizzleAuditLog` (above) — the gap that matters most.
- Metrics backend and dashboards.
- Distributed tracing. Correlation ids are in place; spans are not needed while
  this is one process.
- Error tracking service.
- Log shipping and retention policy — an operational decision.
- Alerting thresholds — meaningless before there is a baseline to set them from.
