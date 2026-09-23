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
and `live` uses a fake RTC provider. Nothing fails at boot for want of a
service — the fallbacks are deliberate and are logged.

With Postgres:

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/institution
npm run db:migrate
npm run start:dev
```

There is **no seeded account and no default password.** The system starts with
zero users, on purpose — see
[open-questions.md Q2](../docs/architecture/open-questions.md).

---

## Scripts

| Command | Does |
| --- | --- |
| `npm run verify` | **The gate.** format:check → lint → typecheck → arch:graph → test |
| `npm test` | Jest: unit, integration and architecture tests |
| `npm run test:arch` | Just the architecture rules |
| `npm run test:integration` | Just the Postgres suites (needs `TEST_DATABASE_URL`) |
| `npm run arch:graph` | dependency-cruiser directly |
| `npm run db:generate` | Diff schema files → a new SQL migration |
| `npm run db:migrate` | Apply pending migrations |
| `npm run build` | Compile to `dist/` |

Run `npm run verify` before pushing. CI runs exactly this, plus a real Postgres.

The Postgres suites **skip with a printed warning** when `TEST_DATABASE_URL` is
unset. To run them locally:

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
               messaging  live  files  notifications  automation  reporting
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
5. **Every route declares a permission** — `@RequirePermission(...)` or
   `@PublicRoute()`. A route that declares neither returns 403 to everyone,
   including you, on the first request. That is intentional.

If a rule is wrong, argue with it in a pull request. Do not route around it —
the violation message tells you which rule and why it exists.
