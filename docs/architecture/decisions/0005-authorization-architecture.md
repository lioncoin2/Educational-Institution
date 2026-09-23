# 0005 — Centralized permission and policy authorization

**Status:** Accepted
**Date:** 2026-09-23

## Context

Ten roles, a dozen modules, and a requirement stated in the negative:

> Avoid scattered checks such as `if user.role == admin`. Instead centralize
> authorization.

Role checks scattered through controllers are the classic failure: adding a role
means finding every `if` in the codebase, and missing one is a silent
vulnerability that no test necessarily catches.

## Decision

One decision point: `PolicyAuthorizationService`. Roles resolve to permissions;
permissions plus policy rules resolve to yes or no, by **deny-overrides**.

```ts
if (decisions.includes('deny')) return false;           // explicit deny always wins
if (principal.permissions.has(permission)) return true; // role baseline
return decisions.includes('permit');                    // a rule may still grant
```

Enforced in two places, deliberately both:
- `PermissionGuard` at the HTTP edge, from a `@RequirePermission(...)` annotation.
- `authorize()` inside use cases, with resource context.

Permissions are a typed catalog; `Permission` is the union of its leaves, so a
mistyped permission is a compile error rather than a silent `false`.

## Consequences

**Good.**
- One place to audit, one place to change, one place to test. The architecture
  test asserts properties of the *scheme* — every permission reachable by some
  role, deny beating permit including for Owner, `abstain` not vetoing — rather
  than properties of individual endpoints.
- Policy rules express what roles cannot: "a teacher may grant speaking
  permission, but only in a room they host." Roles answer the first half and are
  silent on the second.
- Deny-overrides makes suspension, safeguarding restrictions and legal holds
  expressible later without re-architecting.
- The three-valued rule result (`permit` / `deny` / `abstain`) keeps a rule with
  no opinion from vetoing a permission granted elsewhere. Collapsing it to a
  boolean is the usual way these systems become unextendable.

**Bad, and accepted.**
- An indirection: reading a controller does not tell you who can call it, only
  which permission it needs. The `@RequirePermission` annotation is the
  mitigation — the requirement is visible at the route even though the decision
  is not.
- Every permission check is a function call with a set lookup. Irrelevant at
  this scale; if it ever matters, the resolution is cacheable behind the same
  interface.
- Defining a permission catalog up front is work before any feature needs it.

**The load-bearing detail.** `PermissionGuard` refuses routes that declare no
permission:

```ts
if (required === undefined) {
  throw new ForbiddenException('This route declares no permission requirement.');
}
```

The usual arrangement fails *open*: a developer adds a controller method,
forgets the decorator, and ships an unprotected endpoint that nothing catches.
Here it fails *closed* — 403 to everyone, including in development, on the first
request. Public routes say `@PublicRoute()` explicitly, because public is a
decision that should be written down.

## Alternatives considered

**Role checks in controllers.** Rejected — this is the thing the brief ruled out.

**Full ABAC / policy engine (OPA, Casbin).** Genuinely more expressive, and a
reasonable end state. Rejected for now: an external policy engine is another
deployment, another language for rules, and another place for the rules to be
out of sync with the code. `PolicyRule` is an interface; adopting an engine
later means implementing it once.

**ACLs per resource.** Rejected: right for file-sharing products, wrong for an
institution whose access model is fundamentally role-shaped with a few
ownership exceptions. Ownership is covered by `ownerOfResourceRule`.

## Note

The role→permission matrix currently in code is `PROVISIONAL_ROLE_PERMISSIONS`,
and `POLICY_RULES` is empty. What each role may actually do is an institutional
decision, not an engineering one — see open-questions.md Q1. This ADR is about
the mechanism, which is complete and tested; it is not a claim about the
matrix's contents.
