# Educational Institution — repository guide

A platform for running an educational institution: a **Flutter** app (`app/`) and a
**NestJS/TypeScript modular-monolith** backend (`backend/`). This file only points
at the authoritative material; it does not restate it.

## Read first, in order (every task)

1. **[`docs/ENGINEERING_RULES.md`](docs/ENGINEERING_RULES.md)** — permanent
   engineering governance and the mandatory INSPECT → … → COMMIT workflow. Read
   first, obey always.
2. **[`docs/project-checkpoint.md`](docs/project-checkpoint.md)** — the current,
   reversible state of the work (the continuity source): what has landed, what is
   deferred, what not to reopen.
3. **[`docs/architecture/overview.md`](docs/architecture/overview.md)** — the
   system shape: modules, layers, and what is deliberately not built.

## Navigate with the architecture index

**[`docs/architecture/architecture-index.md`](docs/architecture/architecture-index.md)**
is a generated, code-derived map: every backend module (path, public `contracts/`
surface, Nest entry point, declared domain events, static-import edges) and every
Flutter feature (controllers, static-import edges), plus the repository contracts,
routes and entry points, each linked to its docs. Start there to find the owner of
a behaviour and its files, then open only what the task touches.

- It is **generated — do not hand-edit.** Regenerate: `cd backend && npm run arch:index`.
  `npm run arch:index:check`, and the `architecture-index` test in `npm run verify`,
  fail the build if it is stale.
- Its edges are **static imports, not runtime calls.** Modules collaborate at
  runtime mainly through the in-process event bus
  ([`docs/architecture/events.md`](docs/architecture/events.md)); those
  relationships are the declared events in each module's `contracts/`.

## The enforced boundaries (do not work around them)

- [`docs/architecture/module-boundaries.md`](docs/architecture/module-boundaries.md)
  — each module's remit and what it must not know.
- [`docs/architecture/dependency-rules.md`](docs/architecture/dependency-rules.md)
  — the executable backend rules (`backend/.dependency-cruiser.cjs` +
  `backend/test/architecture/*`), run in CI.
- Flutter layer directions: `app/test/architecture/layering_test.dart`, plus the
  per-feature `app/test/**/*_boundaries_test.dart`.
- [`docs/architecture/decisions/`](docs/architecture/decisions/) — the ADRs (why),
  indexed in [`decisions/README.md`](docs/architecture/decisions/README.md).

## Gates before any commit

- Backend: `cd backend && npm run verify`
- Flutter: `cd app && flutter analyze && flutter test`

Full Definition of Done: [`docs/ENGINEERING_RULES.md`](docs/ENGINEERING_RULES.md) §15.
