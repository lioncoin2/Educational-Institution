# Backend

Modular monolith. NestJS 11, TypeScript 5.7, Node 22, PostgreSQL, Drizzle.

The architecture is documented in
[`docs/architecture/`](../docs/architecture/overview.md) — start with the
overview, then [dependency-rules.md](../docs/architecture/dependency-rules.md),
which describes the boundaries this codebase enforces mechanically.

---

## Running it

```bash
npm ci
cp .env.example .env     # then edit
npm run start:dev
```

**It runs with no infrastructure.** Leave `DATABASE_URL` unset and modules fall
back to in-memory adapters; leave the LiveKit secret at its development default
and `live` uses a fake RTC provider; uploaded files go to `STORAGE_LOCAL_ROOT`
(`./.storage`, git-ignored). Nothing fails at boot for want of a service — the
fallbacks are deliberate and are logged.

Production refuses to start without its own `JWT_SECRET` and
`STORAGE_SIGNING_SECRET` (each ≥ 32 bytes, not a placeholder, not equal to each
other). For the Flutter **web** app, list its origin in `CORS_ORIGINS`
(explicit origins only; native apps need nothing) — the same list decides
which browser pages may open the realtime WebSocket. See `.env.example`.

The realtime endpoint is served by the same process, on the same port:
`ws://localhost:3000/realtime`. Nothing to configure; with no one connected it
costs nothing.

Push notifications need no configuration either, because no provider is wired
yet: the push port's only adapter logs, at debug level, that a push would have
gone out — never the device token. Choosing FCM or APNs is open question Q24;
see [notifications.md §12](../docs/architecture/notifications.md#12-push).

With Postgres:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/institution
npm run db:migrate
npm run build && npm run academic:seed-structure   # the institution's sections, programs and 45 halaqat
npm run start:dev
```

**The academic structure is seeded by an explicit step, not a migration.**
`academic:seed-structure` creates the sections, programs and halaqat the
institution profile states (from
`src/modules/academic/application/institution-structure.json`) — by code, only
what is missing, never overwriting what an administrator has changed since —
and prints what it created and found. Run it once after migrating, and again
safely at any time. It creates no student, teacher, enrollment or progress.
Without a database the in-memory store is seeded at boot. See
[academic.md §11](../docs/architecture/academic.md).

There is **no seeded account and no default password.** The system starts with
zero users, on purpose. Create the first owner on the server — the password is
read from standard input, never from an argument or the environment:

```bash
npm run build
read -rs OWNER_PW && printf '%s\n' "$OWNER_PW" | \
  node dist/cli/bootstrap-owner.js --email owner@institution.org --name "Full Name"
```

It refuses once an active owner exists. Every other account is created by staff
through `/admin/users`. See
[authentication.md](../docs/architecture/authentication.md).

---

## The API so far

| | Endpoint | Access |
| --- | --- | --- |
| Sign in | `POST /auth/login` | public · rate-limited |
| Refresh | `POST /auth/refresh` | public · rate-limited |
| Sign out | `POST /auth/logout` | authenticated |
| Who am I | `GET /auth/me` | authenticated |
| My devices | `GET /auth/sessions`, `DELETE /auth/sessions/:id` | authenticated |
| My password | `POST /auth/password` | authenticated · rate-limited |
| Accounts | `GET /admin/users`, `GET /admin/users/:id` | `users.read` |
| Create | `POST /admin/users` | `users.manage` |
| Roles | `POST /admin/users/:id/roles`, `DELETE …/roles/:role` | `roles.assign` |
| Status | `POST /admin/users/:id/status` | `users.manage` |
| Reset password | `POST /admin/users/:id/password` | `users.manage` |
| Sign out everywhere | `DELETE /admin/users/:id/sessions` | `sessions.manage` |
| Live | `POST /live/sessions/:id/join` · `…/hand`, `POST /live/requests/:id/grant` · `…/revoke` | `live.*` |
| Upload a file | `POST /files/uploads` → `PUT <signed url>` → `POST /files/uploads/:id/complete` | `files.upload` |
| Local storage transfer | `PUT` / `GET /files/local/:token` | public · the signature is the authorization |
| Conversations | `GET /messaging/conversations`, `GET …/:id`, `GET …/:id/participants` | `messaging.read` + membership |
| Start one | `POST /messaging/conversations/direct` · `/groups` · `/channels` | `messaging.start_direct` · `create_group` · `create_channel` |
| Messages | `GET …/:id/messages?before\|after`, `POST …/:id/read` | `messaging.read` + membership |
| Send | `POST …/:id/messages/text` · `/voice` · `/image` · `/file` | `messaging.send` + membership |
| Attachment link | `GET …/:id/messages/:messageId/attachments/:fileAssetId/link` | `messaging.read` + `files.read` + membership |
| Membership | `POST …/:id/participants`, `DELETE …/participants/:userId`, `POST …/:id/leave` | owner / moderator, per use case |
| My notifications | `GET /notifications?cursor&limit`, `GET /notifications/unread-count` | authenticated · your own only |
| Mark read | `POST /notifications/:id/read`, `POST /notifications/read-all` | authenticated · your own only |
| Notification settings | `GET` / `PATCH /notifications/preferences` | authenticated · your own only |
| Push devices | `POST /notifications/devices`, `DELETE /notifications/devices/:id` | authenticated · rate-limited · your own only · the token is never returned |
| Academic catalogue | `GET /academic/sections`, `GET /academic/sections/:id` · `/programs/:id` · `/halaqat/:id` | `academic.read` |
| Academic structure | `POST /academic/sections` · `/programs` · `/halaqat`, `PATCH …/:id`, `POST …/:id/activate` · `/deactivate` | `academic.manage` |
| Enrollment | `POST /academic/halaqat/:id/enrollments`, `POST /academic/enrollments/:id/end`, `GET /academic/students/:userId/enrollments` | `academic.manage` |
| Teaching | `POST /academic/halaqat/:id/teachers`, `POST /academic/teacher-assignments/:id/end`, `GET /academic/teachers/:userId/assignments` | `academic.manage` |
| A halaqa's people | `GET /academic/halaqat/:id/students` · `/teachers` | `academic.read` + `academic.manage`, or an ACTIVE assignment to that halaqa |
| My academic record | `GET /academic/me`, `GET /academic/me/enrollments` · `/teaching` | `academic.read` · your own only |
| Health | `GET /health/live`, `GET /health/ready` | public |
| Realtime | WebSocket `/realtime` — `auth`, `subscribe`, `ping` in; `message.sent`, `message.read`, `conversation.created`, `participant.added` / `.removed`, `notification.created`, `notification.read`, `notification.read_all` out | access token in the first frame · `messaging.read` · events only for conversations you are in, and only your own notifications |

Messaging and files are described in
[messaging.md](../docs/architecture/messaging.md) and
[storage.md](../docs/architecture/storage.md); notifications in
[notifications.md](../docs/architecture/notifications.md); the academic core
in [academic.md](../docs/architecture/academic.md); the realtime protocol in
[realtime.md, Part M](../docs/architecture/realtime.md).

Errors always have one shape:
`{ "error": { "kind"?, "code", "message", "details"? }, "requestId" }`.

---

## Scripts

| Command | Does |
| --- | --- |
| `npm run verify` | **The gate.** format:check → lint → typecheck → arch:graph → test |
| `npm test` | Jest: unit, integration and architecture tests |
| `npm run test:arch` | Just the architecture rules |
| `npm run test:integration` | Just the Postgres suites (needs `TEST_DATABASE_URL`) |
| `npm run identity:bootstrap-owner` | Create the first owner (after `npm run build`; password on stdin) |
| `npm run academic:seed-structure` | Seed the institution's academic structure from its profile — idempotent, never overwrites (after `npm run build` and `npm run db:migrate`) |
| `npm run arch:graph` | dependency-cruiser directly |
| `npm run db:generate` | Diff schema files → a new SQL migration |
| `npm run db:migrate` | Apply pending migrations |
| `npm run build` | Compile to `dist/` |

Run `npm run verify` before pushing. CI runs exactly this, plus a real Postgres.

The Postgres suites **skip with a printed warning** when `TEST_DATABASE_URL` is
unset. Each suite creates and drops its own database, so point it at a server
where the user may `CREATE DATABASE`. To run them locally:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/institution_test npm test
```

---

## Layout

```
src/
  shared/      the kernel: Id, Result, Clock, DomainEvent, Principal, AuditLog
               — no npm dependencies, imported by everything
  platform/    config, logging, HTTP plumbing, event bus, database, health
               — knows nothing about business modules
  modules/     identity  people  academic  operations  assignments
               messaging  live  files  notifications  realtime  automation
               reporting
```

Inside a module:

```
domain/          entities, invariants and PORTS — imports nothing at all
application/     use cases: orchestration, authorization, transactions
infrastructure/  adapters implementing the domain's ports
api/             controllers, DTOs, guards
contracts/       the module's ONLY public surface
```

---

## The rules you will hit first

These are enforced by `npm run verify`, so you will meet them as build failures
rather than as review comments. Each exists for a reason recorded in
[dependency-rules.md](../docs/architecture/dependency-rules.md).

1. **`domain/` may not import anything** — no npm package, no Node core module.
   Whatever it needs is a port it declares and infrastructure implements.
2. **Cross-module imports go through `contracts/`** — never another module's
   `domain/`, `application/`, `infrastructure/` or `api/`.
3. **`platform/` may not import `modules/`.**
4. **Only `platform/config` reads the environment.**
5. **Every route declares exactly one access level** — `@PublicRoute()`,
   `@Authenticated()` or `@RequirePermission(...)`. A route that declares none
   returns 403 to everyone, including you, on the first request, and the
   architecture test fails the build. That is intentional.
6. **Use cases authorize themselves**, with the resource in context. The route
   guard is the coarse check; a job or event handler calling the same use case
   passes through no guard.
7. **Domain files import specific contract files, never a contracts barrel** —
   the transitive rule will show you the chain to `@nestjs/common` if you do.

If a rule is wrong, argue with it in a pull request. Do not route around it —
the violation message tells you which rule and why it exists.
