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

`NODE_ENV` is `development`, `test`, `staging` or `production`; anything else
refuses to start. Staging and production are the deployed environments, and
both refuse to start without their own `JWT_SECRET` and
`STORAGE_SIGNING_SECRET` (each ≥ 32 bytes, not a placeholder, not equal to each
other). For the Flutter **web** app, list its origin in `CORS_ORIGINS`
(explicit origins only; native apps need nothing) — the same list decides
which browser pages may open the realtime WebSocket. See `.env.example`.

The realtime endpoint is served by the same process, on the same port:
`ws://localhost:3000/realtime`. Nothing to configure; with no one connected it
costs nothing.

A community's chat needs no configuration either: messaging keeps it in step
with Communities in the background (a wake-up per membership change, and a
sweep at boot and every minute). `MESSAGING_COMMUNITY_CHAT_MAX_SERVED_MEMBERS`
(default 250) switches posting off in chats larger than load testing has
covered — never a limit on who may join; see
[community-chat.md §11.2](../docs/architecture/community-chat.md#112-gates-g1g4).

Live sessions need no configuration to develop against: with the LiveKit
secret at its development default, `live` binds a fake media provider that
never carries media, and sessions start, join and end as usual. **Real media
is off unless enabled by name** (the P6 audit's D19): which provider a
deployment binds is decided once, at boot, and logged.

| Configuration | Binds |
| --- | --- |
| `LIVEKIT_API_SECRET` unset, or `development-only-secret` | the fake |
| `LIVE_MEDIA_PROVIDER=livekit` | the LiveKit adapter. Boot is refused unless `LIVE_ROOM_NAME_PREFIX`, `LIVEKIT_URL`, `LIVEKIT_VERSION`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` are set as the table below says. Even then, starting a session answers 503 `live.media_unavailable` until LiveKit's `/rtc/validate` self-check passes: reachable, our key and secret accepted, `room.auto_create` off |
| anything else — real LiveKit credentials included | a disabled provider that refuses every call: starting a session answers 503 `live.media_unavailable` and stores nothing, and the reconciler skips its ticks |

| Variable | Default | Means |
| --- | --- | --- |
| `LIVE_MEDIA_PROVIDER` | unset | `livekit` enables real media; any other value refuses boot |
| `LIVE_ROOM_NAME_PREFIX` | unset (`live-` for the fake and the disabled provider) | this deployment's media room prefix: the orphan sweep ends every room of its form that no live session claims. 1–48 characters of `A–Z a–z 0–9 . _ -`; required with `LIVE_MEDIA_PROVIDER=livekit` |
| `LIVE_MAX_PARTICIPANTS_PER_SESSION` | 300 | the listeners' soft cap, copied onto each session at start (PROVISIONAL, Q57) |
| `LIVE_MODERATOR_RESERVE` | 10 | seats above the cap for moderators and current speakers (PROVISIONAL, Q57) |
| `LIVEKIT_URL` | `ws://localhost:7880` (development and test only) | client → LiveKit: the signalling URL join tickets carry. `ws://` or `wss://`. Required with real media, and in staging and production; in staging and production `wss://` only, real media or not |
| `LIVEKIT_API_URL` | `LIVEKIT_URL` with `ws→http`, `wss→https` | API → LiveKit: the server API the adapter calls, e.g. `http://livekit:7880` on a private network. `http://` or `https://`; in staging and production `https://` unless its host is internal (loopback, a single-label service name, a private IPv4 address) |
| `LIVEKIT_VERSION` | unset | the LiveKit server release deployed. With real media it must be exactly the pinned `1.13.7` |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | `devkey`, `development-only-secret` (development and test only) | the media server's credentials. Required in staging and production, where the secret must not be a placeholder and must differ from `JWT_SECRET` and `STORAGE_SIGNING_SECRET`. With real media: set on purpose, neither a placeholder, and the secret at least 32 bytes and different from both |

See [live.md](../docs/architecture/live.md) (the P6 and P7.1 notes above §1).

**Deploying with real media.** The Docker deployment — the API and the LiveKit
server v1.13.7 as two containers, with one environment file per environment —
is in [`infra/`](../infra/README.md). Its ports, TLS, TURN, the readiness
check, and what was and was not verified are in
[p7-livekit-readiness.md](../docs/p7-livekit-readiness.md).

Push notifications need no configuration either, because no provider is wired
yet: the push port's only adapter logs, at debug level, that a push would have
gone out — never the device token. Choosing FCM or APNs is open question Q24;
see [notifications.md §12](../docs/architecture/notifications.md#12-push).

With Postgres:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/institution
npm run db:migrate
npm run build && npm run academic:seed-structure   # the printed profile's sections, programs and 45 halaqat (see the hold below)
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

**Hold: do not run it against a production or shared database yet.** The
file holds the *printed* profile's structure, and the owner has since
described a different one. That description is not yet mapped
([owner-information.md](../docs/owner-information.md), open questions
Q35–Q39). Seeding makes the codes, `sec-spelling`'s kind and literacy's five
halaqat permanent, and later edits to the file do not update existing rows.
Development and scratch databases are fine. See
[academic-reconciliation.md §14](../docs/architecture/academic-reconciliation.md#14-hazards-and-operating-rules-while-the-reconciliation-is-open).

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
| Start a live session | `POST /live/communities/:communityId/sessions` | `live.moderate` + the community's `community.live.start` · 201 new, 200 the running one |
| Live now | `GET /live/communities/:communityId/sessions/current` | `live.join` + a participant (or a member refused a join only by the community's lifecycle) · `{session: null}` when none runs |
| A live session | `GET /live/sessions/:id` | `live.join` + as "Live now" · ended sessions too |
| Join | `POST /live/sessions/:id/join` | `live.join` + a participant · the only response carrying a media credential (120 s) |
| End | `POST /live/sessions/:id/end` | `live.moderate` + a moderator of the session |
| Raise / lower a hand | `POST /live/sessions/:id/hand`, `DELETE …/hand` | `live.raise_hand` + `community.live.raise_hand`; lowering your own: authenticated |
| The hands | `GET /live/sessions/:id/hands?state&cursor&limit` | `live.moderate` + a moderator of the session |
| Grant / decline / revoke | `POST /live/requests/:id/grant` · `/decline` · `/revoke` | `live.moderate` + a moderator of the session; never on the host's own hand unless the host |
| Screen share | `POST /live/sessions/:id/screen-share`, `DELETE …/screen-share` | claim: `live.moderate` + a moderator holding `live.speak`, for themself; stop: authenticated — the presenter, or a moderator of the session (never the host's grant unless the host) |
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
[realtime.md, Part M](../docs/architecture/realtime.md); live sessions in
[live.md §15](../docs/architecture/live.md#15-api-under-live), where the
refusal codes are listed. On every `/live` route, a session or community the
caller may not take part in answers the same 404 as one that does not exist,
and no route takes a body.

Errors always have one shape:
`{ "error": { "kind"?, "code", "message", "details"? }, "requestId" }`.

---

## Scripts

| Command | Does |
| --- | --- |
| `npm run verify` | **The gate.** format:check → lint → typecheck → arch:graph → test |
| `npm test` | Jest: unit, integration, architecture and deployment tests (`test/deployment/`, which read the committed `infra/` files). Not the real LiveKit suite, which it excludes rather than skips |
| `npm run test:livekit` | The real LiveKit suite (`test/livekit/`): the application against the pinned LiveKit server v1.13.7, with a real WebRTC client. It starts and stops its own servers; the release is downloaded once, checked by sha256 and cached in `.cache/` (git-ignored), or taken from `LIVEKIT_SERVER_BINARY`, which is needed on anything but linux x64 |
| `npm run test:arch` | Just the architecture rules |
| `npm run test:integration` | Just the Postgres suites (needs `TEST_DATABASE_URL`) |
| `npm run identity:bootstrap-owner` | Create the first owner (after `npm run build`; password on stdin) |
| `npm run academic:seed-structure` | Seed the institution's academic structure from its profile — idempotent, never overwrites (after `npm run build` and `npm run db:migrate`) |
| `npm run arch:graph` | dependency-cruiser directly |
| `npm run db:generate` | Diff schema files → a new SQL migration |
| `npm run db:migrate` | Apply pending migrations |
| `npm run build` | Compile to `dist/` |

Run `npm run verify` before pushing. CI runs exactly this, plus a real Postgres
and a check that the deployment files are valid Compose for every environment;
`npm run test:livekit` runs in a CI job of its own.

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
