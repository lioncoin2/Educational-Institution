# Authorization

The requirement that drove this design:

> Avoid scattered checks such as `if user.role == admin`. Instead centralize
> authorization.

So there is exactly **one** decision point in the system:
`PolicyAuthorizationService`. Nothing else decides whether an action is
permitted. Guards ask it. Use cases ask it. The dashboard asks it to decide
which widgets to show. No module — including identity's own HTTP layer —
reimplements the decision.

---

## 1. The model

Four concepts, in the order a request meets them:

**Principal** — the authenticated actor: a `userId`, the role names they hold,
and their already-resolved effective permissions.

```ts
interface Principal {
  readonly userId: string;
  readonly roles: readonly string[];      // for audit and policy rules — not for `if` checks
  readonly permissions: ReadonlySet<string>;
}
```

The comment on `roles` is load-bearing. Roles are carried so that policy rules
and audit entries can refer to them. They are not there to be branched on.

**Permission** — a leaf in a catalog, e.g. `live.speaker.grant`,
`operations.attendance.amend`, `identity.role.assign`.

The catalog is a nested const object, and the `Permission` type is the union of
its leaves:

```ts
export const Permissions = {
  identity: { user: { read: 'identity.user.read', ... }, ... },
  live:     { speaker: { grant: 'live.speaker.grant', ... }, ... },
  ...
} as const;

export type Permission = Leaves<typeof Permissions>;
```

That indirection buys one specific thing: **a mistyped permission is a compile
error, not a silent `false`.** `@RequirePermission('live.speaker.gant')` does not
build. Without it, a typo produces a route that nobody can ever access, and
which no test would necessarily catch.

**Role** — a named bundle of permissions. Ten exist:
Owner, Administrator, Supervisor, Teacher, Assistant Teacher, Student, Parent,
Content Manager, Support, Auditor.

**Policy rule** — a resource-scoped decision that roles cannot express.

---

## 2. Why roles alone are not enough

A Teacher holds `live.speaker.grant`. But only for a room *they actually run*.
Role-based permissions answer the first half of that sentence and are silent on
the second.

So permissions are evaluated against an optional `AuthorizationContext` —
resource id, owner, halaqa — by a set of `PolicyRule`s:

```ts
interface PolicyRule {
  readonly id: string;
  appliesTo(permission, context): boolean;   // cheap pre-filter
  evaluate(principal, permission, context): 'permit' | 'deny' | 'abstain';
}
```

The three-valued return matters. `abstain` is not `deny`: a rule that has no
opinion must not veto a permission granted elsewhere. Collapsing it to a boolean
is the usual way these systems become impossible to extend.

---

## 3. Combination: deny-overrides

```ts
export function evaluateAccess(principal, permission, context, rules): boolean {
  const applicable = rules.filter((r) => r.appliesTo(permission, context));
  const decisions  = applicable.map((r) => r.evaluate(principal, permission, context));

  if (decisions.includes('deny')) return false;          // 1. explicit deny always wins
  if (principal.permissions.has(permission)) return true; // 2. role baseline
  return decisions.includes('permit');                    // 3. a rule may still grant
}
```

Three properties, each chosen rather than inherited:

1. **An explicit deny always wins**, including over the Owner role. This is what
   makes suspension, safeguarding restrictions and legal holds expressible
   later without re-architecting.
2. **Roles are the baseline**, so the common case needs no rules at all.
3. **A rule may grant what roles do not** — that is how ownership works: a
   student may read *their own* submission without holding a blanket
   `assignments.submission.read`.

And the default: **anything unproven is denied.** There is no fall-through that
permits.

`POLICY_RULES` is currently registered as an empty array. That is deliberate,
not unfinished: ownership scoping, halaqa scoping and supervisor scoping are all
*institutional* rules, and inventing them was explicitly out of bounds. The
mechanism is built and tested with `ownerOfResourceRule` as a worked example;
the institution's actual rules are [open question Q1](open-questions.md).

---

## 4. Enforcement at the HTTP edge

Two global guards, registered via `APP_GUARD`:

**`AuthenticationGuard`** verifies the bearer token, then resolves a
`Principal` — by calling `authorization.principalFor(...)`, *not* by importing
identity's domain. (The architecture test caught that exact violation during
development; the fix was to widen the contract, not weaken the rule.)

**`PermissionGuard`** reads the route's declared requirement and asks the
authorization service.

```ts
@Post('sessions/:sessionId/speakers')
@RequirePermission(Permissions.live.speaker.grant)
async grantSpeaker(...) { ... }
```

The guard contains no rules of its own. It reads an annotation and delegates.
That is the whole mechanism by which `if (role === 'admin')` is kept from
reappearing at the edges.

### Unannotated routes are refused

```ts
if (required === undefined) {
  throw new ForbiddenException('This route declares no permission requirement.');
}
```

This is the most important line in the guard, and it is worth being explicit
about why.

The usual arrangement fails **open**: a developer adds a controller method,
forgets the decorator, and ships an unprotected endpoint. Nothing breaks, no
test fails, and the hole is found by someone else.

Here it fails **closed**. A route with no declared permission returns 403 to
everyone, including in development, on the first request. The mistake is
immediate, obvious, and impossible to ship past a smoke test.

Genuinely public routes say so explicitly — `@PublicRoute()` on login and on the
health endpoints. Public is a decision that must be written down.

---

## 5. Use-case-level authorization

Guards are necessary and not sufficient. They see a route and a principal; they
do not see the resource. `live.speaker.grant` on a room you do not host passes
the guard and must still be refused.

So use cases authorize again, with context:

```ts
const allowed = this.authorization.authorize(
  command.principal,
  Permissions.live.speaker.grant,
  { resourceType: 'LiveSession', resourceId: command.sessionId, ownerUserId: room.hostUserId },
);
if (!allowed.ok) return allowed;
```

`authorize()` returns a `Result` rather than throwing, because to a use case a
refusal is an expected outcome, not an exception. The controller turns it into a
403 via `unwrap()`. Guards get `can()` — the same decision, boolean-shaped.

Every implemented use case authorizes **before** any side effect. The live tests
assert this directly: a denied caller results in zero tokens minted, checked by
inspecting the fake provider rather than by trusting the ordering of the code.

---

## 6. Authentication

- Passwords: `scrypt` (N=16384, r=8, p=1), Node built-in, no native build.
  Format `$scrypt$N$r$p$salt$hash`, verified with `timingSafeEqual`. A malformed
  stored hash verifies as `false` rather than throwing.
- `AuthenticateUseCase` returns **one indistinguishable failure** for
  unknown-user and wrong-password, and hashes against a dummy value on the
  unknown-user path so response timing does not reveal whether an account
  exists.
- Tokens are short-lived and minted server-side. The Flutter client holds no
  secrets of any kind.

There is **no seeded account and no default credential** anywhere in this
repository. Shipping a known owner login would be both a security hole and an
invented institutional rule. How the first owner is provisioned is
[open question Q2](open-questions.md).

---

## 7. What is tested

`test/architecture/authorization.spec.ts` asserts properties of the scheme
itself, not of one endpoint:

- Every permission in the catalog is reachable by at least one role — an
  unreachable permission is a bug in the matrix.
- Deny beats permit, including against the Owner role.
- `abstain` does not veto.
- An unknown role contributes nothing rather than throwing.
- The catalog contains no duplicate permission strings.

Plus unit tests for `evaluateAccess`, the role resolver, and the scrypt hasher.

---

## 8. Deliberately deferred

- Refresh tokens and session revocation.
- Permission caching (the resolution is a set union over ten roles; measure
  before optimizing).
- Delegation and time-boxed grants ("acting supervisor until Friday").
- Field-level authorization.
- The institution's real role→permission matrix and its real policy rules — Q1.
