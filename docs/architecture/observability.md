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

Sixteen sensitive field names are censored at **every depth from zero to
three**: `password`, `currentPassword`, `newPassword`, `initialPassword`,
`passwordHash`, `refreshToken`, `refreshTokenHash`, `previousRefreshTokenHash`,
`accessToken`, `token`, `pushToken`, `deviceToken`, `secret`, `jwtSecret`,
`apiSecret`, `signingSecret`. The `authorization`
and `cookie` request headers are censored too. Request bodies are not logged at
all.

**Correction to the Foundation.** It configured `*.password`, `*.apiSecret`
and so on, and claimed these caught a secret "wherever it appears in a logged
object, including inside a config dump". That was false. pino's `*` matches
*exactly one* level, so `logger.info({ password })` at the top level, and
`{ config: { auth: { jwtSecret } } }` two levels down, were both logged in
clear. It was found during Identity & Access V1 by testing the claim rather
than trusting it. Paths are now generated for each depth. A test logs every
secret at every depth, and a dump of the real application config, and fails if
any value survives.

**A failed query never logs the values it ran with** (Communities P2 review,
2026-09-23). Drizzle wraps a driver error as `Failed query: <sql>\nparams:
<values>`, and pino's error serializer copies that message into both
`message` and `stack`, and the `params` field as-is. So a statement timeout
during a sign-in or a link redemption would have written a refresh-token hash
or an invitation-token hash to the log. The `err` serializer
(`serializeError` in `logger-options.ts`) now replaces the bind values with
`[redacted]` wherever they appear, and drops the value-bearing fields of a
Postgres error (`detail`, which echoes the row or key, plus `where` and
`internalQuery`). The SQL text, with its `$n` placeholders, and the SQLSTATE
are kept. A test logs a real `DrizzleQueryError` through the application's
own serializers and fails if a bound value survives.

An inbound `x-request-id` is adopted only if it looks like an id
(`[A-Za-z0-9._-]{1,128}`), so a client cannot inject text into every log line
of its own request.

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

### State

**With a database, entries go to Postgres** through `DrizzleAuditLog`. It is
append-only, with no update or delete path, and it is tested against real
Postgres. Without a database (local development), `LoggingAuditLog` writes them
to the structured log instead.

Identity records these actions (`identity/application/audit-actions.ts`):

| Action | Actor | Notes |
| --- | --- | --- |
| `identity.login.succeeded` | the user | platform; client IP |
| `identity.login.failed` | — | reason; user id if known, else `unknown`; client IP. **Never** the attempted identifier: people type passwords into the username field |
| `identity.logout` | the user | |
| `identity.session.refreshed` | the user | generation; client IP |
| `identity.session.refresh_rejected` | — | a well-formed token that is not the session's |
| `identity.session.refresh_reuse_detected` | — | replayed vs concurrent; the session is ended |
| `identity.session.revoked` | user or admin | reason |
| `identity.password.changed` | the user | how many other sessions ended |
| `identity.password.reset` | the admin | how many sessions ended |
| `identity.user.created` | the admin | identifier *kind* only |
| `identity.account.activated` / `.suspended` / `.disabled` | the admin | from, to, sessions ended |
| `identity.role.assigned` / `.revoked` | the admin | role code |
| `identity.owner.bootstrapped` | — | |
| `identity.role_permissions.changed` | — | **reserved**; the use case is deferred |

Live now records `live.speaker.granted` / `live.speaker.revoked` in this same
trail as well as in its own moderation log. The Foundation document claimed it
already did; it did not.

**What never appears:** passwords, tokens, hashes, attempted identifiers.
Tests search the recorded entries for each of these.

**The gap that remains:** an entry is written *after* the change it describes,
by the use case that made the change. If that write fails, the change has
already been persisted and its record is missing. The failure surfaces as an
error, not silently. Closing the gap needs a unit of work spanning both writes;
it is deferred.

### What must eventually be audited

Role and permission changes; teacher assignment changes; attendance
modifications (which is why `AttendanceAmendment` requires a reason and an
amender in the contract); live-room moderation; administrative actions on
another person's record.

`ModerateSpeakerUseCase` writes one, in the deliberate order: own state →
provider → **audit** → event. Audit comes before the event because the record
of the act matters more than the reaction to it.

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
{ "error": { "kind": "forbidden", "code": "identity.permission_denied",
             "message": "...", "details": {} },
  "requestId": "..." }
```

`kind` is present whenever the failure is classified: always for use-case
failures, and for framework errors whose status maps to a kind (401, 403, 404,
409, 412, 422, 429). A 400 has no kind: it means the request was malformed, not
that anything failed. Clients branch on `kind` and `code`; `message` is for
people. A 429 also carries a `Retry-After` header.

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

- A unit of work so an audit entry commits with the change it records.
- A Redis `RateLimiter` for more than one instance.
- Metrics backend and dashboards.
- Distributed tracing. Correlation ids are in place; spans are not needed while
  this is one process.
- Error tracking service.
- Log shipping and retention policy — an operational decision.
- Alerting thresholds — meaningless before there is a baseline to set them from.
