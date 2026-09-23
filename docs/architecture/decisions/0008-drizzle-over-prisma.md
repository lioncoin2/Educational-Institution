# 0008 — Drizzle ORM rather than Prisma

**Status:** Accepted
**Date:** 2026-09-23

## Context

The backend needs PostgreSQL access. Prisma is the default choice in the
TypeScript ecosystem and is better in several respects: a nicer client, a
mature migration story, strong tooling.

This system's organizing constraint is module ownership: a module owns its
tables and no other module may read them.

## Decision

Drizzle ORM.

The deciding factor is where schema lives. Prisma requires **one global
`schema.prisma`** — every module's tables in a single file. That file would be:

- edited by everyone, for every module, forever;
- a place where a query in `messaging` can trivially join `operations`' tables,
  with nothing preventing it;
- the one artifact that must move *in its entirety* if a module is extracted.

It would quietly undo the boundaries the rest of this architecture spends its
effort enforcing. Not through a bad decision, but through the absence of any
mechanism preventing a convenient one.

Drizzle lets each module declare its tables beside the adapter that uses them:

```
src/modules/identity/infrastructure/schema.ts
src/platform/audit/schema.ts
```

collected by glob in `drizzle.config.ts`:

```ts
schema: ['./src/platform/**/schema.ts', './src/modules/*/infrastructure/schema.ts']
```

Table ownership now matches module ownership, and `no-cross-module-internals`
applies to schema files exactly as it applies to everything else.

## Consequences

**Good.**
- Schema ownership matches module ownership, enforced by the same rule as the
  rest of the code.
- Extracting a module takes its schema with it.
- SQL-shaped query builder: what runs is legible from what is written, which
  matters for the queries that will eventually need indexes.
- No code generation step; types are inferred from the schema definitions.
- Migrations are plain SQL files, reviewed like code.

**Bad, and accepted.**
- Smaller ecosystem and fewer answered questions than Prisma.
- No Prisma Studio equivalent.
- More verbose for simple queries.
- **Platform's Drizzle handle is schema-less** — `NodePgDatabase<Record<string,
  never>>` — because `platform-knows-no-modules` forbids platform from importing
  module schemas. The consequence is that Drizzle's relational query API
  (`db.query.users...`) is unavailable; the select/insert builder that
  repositories actually use is unaffected.

That last point is a real cost: a convenience API given up to keep an
architectural rule true. It is recorded in `persistence.md` as well, so the next
person does not "fix" it by importing every module's schema into platform.

## Alternatives considered

**Prisma.** Better DX in isolation. Rejected for the single-schema-file reason
above. If module boundaries were not the organizing constraint, this would
probably be the right choice.

**TypeORM.** Decorator-based entities would put ORM decorators on domain objects
— directly violating `domain-is-dependency-free` — or require a second set of
persistence entities and a mapping layer. Rejected.

**Raw SQL with `pg`.** Maximum control, no abstraction. Rejected: hand-written
mapping and no compile-time schema checking, for no benefit this project needs.

**Kysely.** Very close to Drizzle on every axis that mattered here, and a
defensible alternative. Drizzle chosen for its integrated migration generation
(`drizzle-kit`), which Kysely leaves to a separate tool.
