# 0009 — Enforce boundaries with dependency-cruiser in CI

**Status:** Accepted
**Date:** 2026-09-23

## Context

Every decision in ADRs 0002–0008 depends on boundaries being real. A boundary
that exists only in documentation is a boundary that erodes: not through
malice, but through a reasonable-looking import on a Friday afternoon.

The brief asked for automated architecture tests or dependency checks.

## Decision

`dependency-cruiser`, configured in `backend/.dependency-cruiser.cjs`, run three
ways:

```bash
npm run arch:graph   # directly
npm run test:arch    # as a Jest test
npm run verify       # in the full gate, and in CI
```

Thirteen rules, each with a `comment` field stating what it prevents. The full
list, with reasoning, is in `docs/architecture/dependency-rules.md`.

The headline rule: **the domain layer may not import any npm package or Node
core module.** Not Nest, not LiveKit, not Drizzle, not `node:crypto`.

## Consequences

**Good.**
- An illegal import fails the build in the same breath as a broken unit test.
- The rules are self-documenting: each violation prints the `comment` explaining
  why the boundary exists, so the person who hits it learns the reason at the
  moment they need it.
- It works. Three real violations were caught during this milestone, all of
  which had been written by someone (me) who knew the rules and still drifted:

  | Violation | Fix |
  | --- | --- |
  | `AuthenticationGuard` → `identity/domain/role.ts` | Added `principalFor()` to identity's public contract — the capability belonged there, since the HTTP edge needs it on every request |
  | `files/contracts` → `files/domain/storage-provider.ts` | Moved `STORAGE_PROVIDER` ownership into `contracts/`; domain imports it from there |
  | `live.module.ts` → `identity.module.ts` | Amended the rule: a module's root `*.module.ts` is Nest's declared composition surface |

  Two were fixed by changing the code. One was fixed by changing the rule, with
  the reasoning recorded in the rule's own comment. That distinction is the
  process working, not failing.

**Bad, and accepted.**
- Rules can be weakened by anyone who edits the config. The mitigation is
  social: a rule change requires the `comment` updated, the docs updated, and
  a superseding ADR if it reverses a decision. Visible in a diff, arguable in
  review.
- False positives happen, and the third violation above was one. The response
  — argue with the rule in a pull request, not with an inline suppression — is
  the difference between a rule set that stays meaningful and one that becomes
  a field of disable comments.
- `dependency-cruiser` v16 is ESM-only, so the Jest (CommonJS) test shells out
  to the `depcruise` CLI and parses its JSON. Slightly awkward; it also means
  the test runs precisely what CI runs.

## Implementation note

The boundary test guards against a vacuous pass:

```ts
it('analysed the source tree', () => {
  expect(output.summary.totalCruised).toBeGreaterThan(40);
});
```

Without it, a misconfiguration that analysed zero files would report zero
violations and go green — the worst possible failure for a test whose entire job
is to fail.

Current state: **no dependency violations found (108 modules, 235 dependencies
cruised).**

## Alternatives considered

**ESLint `no-restricted-imports`.** Works for simple path rules. Rejected: it
cannot express "module A may not import module B's internals, for any A and B"
without enumerating every pair — the `no-cross-module-internals` rule uses a
capture-group backreference (`^src/modules/([^/]+)/` → `pathNot:
['^src/modules/$1/', ...]`) to say it once.

**Nx or a monorepo tool with enforced module boundaries.** Genuinely good at
this. Rejected: a whole build-system migration to get one capability this
project gets from a config file.

**Code review alone.** Rejected. Review catches boundary violations when the
reviewer is thinking about boundaries. The value of a mechanical check is that
it applies on the days nobody is.
