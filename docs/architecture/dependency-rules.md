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
`express`, `nestjs-pino` or `pino`.

`@nestjs/common` **is** permitted, for `@Injectable()` and `@Inject()`. That is a
considered exception: it buys constructor injection, which is what keeps the
ports injectable in the first place, and Nest's decorators do not impose a data
model the way an ORM or an SFK SDK does. It is the one framework concession in
the application layer.

### `api-does-not-touch-adapters`

Controllers depend on use cases, never on adapters. Transport stays swappable
and business logic cannot accumulate at the HTTP edge.

### `api-does-not-touch-domain-internals`

Controllers must not import `domain/`.

Domain entities are not wire formats. Serializing one straight onto an HTTP
response couples the public API to internal modelling, so every future domain
refactor becomes a breaking API change. Controllers speak DTOs.

This rule caught a real violation during development: `AuthenticationGuard`
imported `permissionsForRoles` from `identity/domain/role.ts` to build a
`Principal`. The fix was not to weaken the rule — it was to add
`principalFor()` to identity's public contract, which is where that capability
belonged all along, since the HTTP edge needs it on every request.

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

This rule also caught a real violation: `files/contracts/index.ts` re-exported
`STORAGE_PROVIDER` from `domain/storage-provider.ts`. Ownership was inverted —
the token now lives in `contracts/` and the domain imports it from there.

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
(98 modules, 213 dependencies cruised)**.

---

## Changing a rule

Weakening a rule is allowed. Weakening it silently is not.

A rule change requires: the rule's `comment` field updated to say what is now
permitted and why, a matching update in this document, and — if it reverses an
earlier decision — a new ADR superseding the old one.

The rules exist to make the cost of a shortcut visible at the moment it is
taken. If a rule is wrong, argue with it in a pull request, not in a
`// eslint-disable`-shaped workaround.
