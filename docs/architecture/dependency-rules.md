# Dependency Rules

These rules are **executable**. They live in `backend/.dependency-cruiser.cjs`,
run inside `npm test` via `backend/test/architecture/boundaries.spec.ts`, and run
in CI. An illegal import fails the build in the same breath as a broken unit
test.

That is deliberate. A boundary documented in prose is a boundary that erodes on
the first deadline. A boundary that turns the build red is a boundary.

---

## The rules, and what each one prevents

### `no-circular`

No cycles, anywhere.

A cycle between two modules means neither can be extracted into its own service
without taking the other with it. A cycle inside a module usually means a
missing concept — two things that want to be one, or one thing that wants to be
split.

### `domain-is-dependency-free`

> The domain layer must not import **any** npm package or Node core module.

Not Nest. Not LiveKit. Not Drizzle or `pg`. Not `ioredis`. Not even `node:crypto`.

This is the strictest rule in the system and the most valuable. It means:

- Domain logic is testable with no setup at all — no container, no database, no
  network, no fakes for infrastructure that isn't there.
- The rules of the institution cannot be quietly coupled to a vendor's data
  model. If LiveKit changes its API, the blast radius is one adapter file.
- Anything the domain needs from the outside world must be named as a **port**:
  an interface the domain declares and infrastructure implements.

The cost is real: `ScryptPasswordHasher` lives in infrastructure because
`node:crypto` is not allowed in domain, even though hashing feels domain-ish.
That cost is accepted.

### `domain-reaches-no-npm` and `shared-kernel-reaches-no-npm`

The rule above checks **direct** imports. These two follow every import
**transitively**, using dependency-cruiser's `reachable` rules.

The gap they close is real and easy to fall into. `identity/contracts/index.ts`
re-exports `RequirePermission`, which imports `@nestjs/common`. A domain file
that imports the contracts *barrel*, even for a single type, would pull Nest
into the domain, and no single edge in the chain would break the direct rule.
With these rules, the violation prints the whole path:

```
src/modules/identity/domain/policy.ts →
src/modules/identity/contracts/index.ts →
src/modules/identity/contracts/route-access.ts →
node_modules/@nestjs/common/index.js
```

That chain is not hypothetical. It is the negative control run when the rule
was added. The fix, and the convention: domain files import the specific pure
contract file (`contracts/permissions`, `contracts/authorization`), never the
barrel.

### `domain-does-not-look-outward`

The domain must not import `application/`, `infrastructure/`, `api/` or
`platform/`.

Dependencies point inward. A domain that reaches up into a use case has
inverted the architecture and will drag the whole stack into every unit test.

### `application-does-not-touch-adapters`

Use cases must not import `infrastructure/` or `api/`.

A use case receives its adapters through the port interfaces, injected. The
moment a use case constructs a `LiveKitRtcProvider` itself, the test suite needs
LiveKit credentials and the use case can no longer be run against a fake.

### `application-has-no-vendor-sdks`

Use cases must not import `livekit-server-sdk`, `drizzle-orm`, `pg`, `ioredis`,
`express`, `nestjs-pino`, `pino`, or a WebSocket library (`ws`, socket.io,
`@nestjs/websockets`, `@nestjs/platform-ws`, `@nestjs/platform-socket.io`).

`@nestjs/common` **is** permitted, for `@Injectable()` and `@Inject()`. That is a
considered exception: it buys constructor injection, which is what keeps the
ports injectable in the first place, and Nest's decorators do not impose a data
model the way an ORM or an SFK SDK does. It is the one framework concession in
the application layer.

### `websocket-library-only-in-the-realtime-adapter`

No file under `src/` may import a WebSocket library — `ws`, socket.io and its
client, engine.io, `@nestjs/websockets`, `@nestjs/platform-ws`,
`@nestjs/platform-socket.io`, or their type packages — except
`modules/realtime/infrastructure/`. Realtime delivery is one adapter behind the
realtime module; this is what keeps it replaceable, and what stops messaging,
identity or notifications from ever growing a dependency on how bytes reach a
client. `test/architecture/realtime-boundaries.spec.ts` states the same
properties one by one, and checks the rule is not vacuous (the adapter really
does import `ws`).

### `api-does-not-touch-adapters`

Controllers depend on use cases, never on adapters. Transport stays swappable
and business logic cannot accumulate at the HTTP edge.

### `api-does-not-touch-domain-internals`

Controllers must not import `domain/`.

Domain entities are not wire formats. Serializing one straight onto an HTTP
response couples the public API to internal modelling, so every future domain
refactor becomes a breaking API change. Controllers speak DTOs.

This rule caught a real violation during Foundation V1. `AuthenticationGuard`
imported `permissionsForRoles` from `identity/domain/role.ts` to build a
`Principal`. The fix then was to widen identity's public contract with
`principalFor()`, not to weaken the rule.

Identity & Access V1 replaced that fix with a better one. Resolving a principal
now needs the session and the account's current state, so it became a use case
in identity's application layer (`ResolvePrincipalUseCase`), called by
identity's own `AccessGuard`. `principalFor()` was removed from the public
contract: no other module ever needed it.

### `no-cross-module-internals`

A module may reach another module **only** through its `contracts/` directory.

Reaching into another module's `domain/`, `application/`, `infrastructure/` or
`api/` couples them permanently and silently.

One allowance: a module's root `<name>.module.ts`. In Nest the module class *is*
the composition surface — `imports: [IdentityModule]` grants access to exactly
what `IdentityModule` lists in `exports`, and nothing more. The code-level
boundary still holds, because whatever is exported can only be *referred to*
through `contracts/`.

### `contracts-are-self-contained`

A `contracts/` file must not import the module's own `domain/`, `application/`,
`infrastructure/` or `api/`.

Otherwise a public contract drags the module's internals along with it, and the
boundary is decorative. Contracts may use the shared kernel and other modules'
contracts.

This rule also caught a real violation in the Foundation:
`files/contracts/index.ts` re-exported `STORAGE_PROVIDER` from
`domain/storage-provider.ts`. The Foundation fixed the direction by moving the
token into `contracts/`. Messaging V1 found the deeper defect — the raw storage
port should not be public at all, since a holder could mint a link to any
stored object — and moved it back into `files/domain/`, with the asset-level
`FILE_ASSETS` contract as files' public face (ADR 0011).

### `platform-knows-no-modules`

`platform/` must not import `modules/`.

Platform is the technical substrate: configuration, logging, HTTP plumbing, the
event bus, health checks. If it depended on a business module, the monolith
could never be split and the substrate could never be reused.

This rule is why `Principal` lives in `shared/` rather than in `identity/`:
platform's `@CurrentPrincipal()` decorator needs to name the type, and platform
may not depend on identity. Identity still owns every decision about what a
principal may *do*; `shared/` only describes who they are.

### `shared-kernel-is-pure` and `shared-kernel-has-no-npm`

`shared/` must not import `platform/`, `modules/`, or any npm package.

The shared kernel is imported by every layer *including domain*, so it inherits
the domain's purity requirement transitively. It holds only: `Id`, `Result`,
`Failure`, `Clock`, `DomainEvent`, `EventPublisher`, `Principal`, `AuditLog`,
pagination types, and DI tokens.

It is kept deliberately small. A shared kernel that grows becomes a second,
unversioned dependency for every module — the thing modular boundaries exist to
prevent.

### `no-secrets-outside-config`

Only `platform/config/` may read configuration from the environment.

Every setting is then validated once, in one place, with one failure mode. No
code path can depend on an undeclared environment variable that happens to be
set on someone's laptop.

---

## The picture

```
                    ┌──────────────────────────────┐
                    │          shared/             │  no deps at all
                    └──────────────┬───────────────┘
                                   │ (everyone may use)
   ┌───────────────────────────────┼───────────────────────────────┐
   │                               │                               │
┌──┴────────┐              ┌───────┴────────┐              ┌───────┴────────┐
│ platform/ │              │  module A      │              │  module B      │
│           │              │                │              │                │
│ config    │              │  api ──────┐   │              │  api           │
│ logging   │              │            ↓   │              │   ↓            │
│ http      │◄─────────────│  application   │───contracts─►│  application   │
│ events    │              │            ↓   │              │   ↓            │
│ audit     │              │  domain ◄──────│              │  domain        │
│ health    │              │    ↑           │              │                │
└───────────┘              │  infrastructure│              └────────────────┘
                           └────────────────┘
      ▲                                                       
      └── platform may NOT import modules. Ever.
```

---

## Running the checks

```bash
cd backend
npm run arch:graph   # dependency-cruiser directly
npm run test:arch    # the same rules, as a test
npm run verify       # format + lint + typecheck + arch + all tests
```

`npm run arch:graph` currently reports **no dependency violations found
(150 modules, 499 dependencies cruised)**.

`test/architecture/boundaries.spec.ts` also asserts two properties directly, so
they are named in their own right: nothing outside identity imports anything of
identity's except `contracts/` and `identity.module.ts`, and nothing outside
identity imports identity's schema.

---

## Changing a rule

Weakening a rule is allowed. Weakening it silently is not.

A rule change requires: the rule's `comment` field updated to say what is now
permitted and why, a matching update in this document, and — if it reverses an
earlier decision — a new ADR superseding the old one.

The rules exist to make the cost of a shortcut visible at the moment it is
taken. If a rule is wrong, argue with it in a pull request, not in a
`// eslint-disable`-shaped workaround.
