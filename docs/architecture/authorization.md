# Authorization

**State: implemented and tested** — Identity & Access V1. Every institutional
choice in it is **provisional** and lives in one file:
`backend/src/modules/identity/domain/provisional-policy.ts`.

> Avoid scattered checks such as `if user.role == admin`. Instead centralize
> authorization.

There is exactly **one** decision point, `PolicyAuthorizationService`, behind
the `AuthorizationService` port — the only thing identity exports to other
modules. Guards ask it. Use cases ask it. Nothing branches on a role name.

> **Correction (2026-09-23):** `AuthorizationService` is not the only thing
> identity exports. `IdentityModule` exports three providers:
> `AUTHORIZATION_SERVICE`, `ACCOUNT_DIRECTORY` and
> `ACCESS_TOKEN_AUTHENTICATOR` (`identity/identity.module.ts:181`), as
> [module-boundaries.md](module-boundaries.md#identity) says. It is still
> the only decision point.

---

## 1. The model

**Principal** — who is acting: a user id, their role codes, their effective
permissions, and the session they act through. It is built fresh on every
request from storage (see [authentication.md §5](authentication.md)), so it is
never stale.

**Permission** — `<namespace>.<action>`, from one catalogue in
`identity/contracts/permissions.ts`. `Permission` is a union type derived from
it, so a mistyped permission is a compile error, not a silent "no".

**Role** — a named bundle of permissions, stored in `roles` and
`role_permissions`.

**Policy rule** — a resource-scoped decision roles cannot express: "a teacher
may moderate, *but only rooms they host*".

---

## 2. The permission catalogue

The namespaces the brief named, plus identity's own:

| Namespace | Permissions |
| --- | --- |
| `users` | `read`, `manage` |
| `roles` | `assign` |
| `sessions` | `manage` — *other people's* sessions |
| `audit` | `read` |
| `settings` | `manage` |
| `people` | `read`, `manage` |
| `academic` | `read`, `manage`, `teach`, `study` |
| `attendance` | `read`, `manage` |
| `assignments` | `read`, `submit`, `manage` |
| `messaging` | `read`, `send`, `start_direct`, `create_group`, `create_channel`, `manage` |
| `live` | `join`, `raise_hand`, `speak`, `moderate` |
| `files` | `read`, `upload` |
| `reports` | `read` |

30 permissions. The catalogue says what **can** be granted. It says nothing
about who holds what; that is the role matrix below.

**Academic permissions separate eligibility from access.** `academic.read`
is the catalogue and one's own record; `academic.manage` is structure,
enrollment and assignment. `academic.teach` and `academic.study` grant nothing
by themselves: they say which ACTIVE accounts may be *assigned* to teach or
*enrolled* — so academic asks identity ("does this account hold
`academic.study`?") instead of checking a role name. What a teacher may see
comes from an ACTIVE assignment to that halaqa, never from the permission
([academic.md §5](academic.md)).

**Messaging permissions are always membership-scoped.** `messaging.read` means
"may read the conversations you are a current member of", never "may read
messages"; `messaging.send` means "may post where you are a member and the
conversation allows it". Starting a conversation is separate from taking part
(`start_direct`, `create_group`, `create_channel`), because who may initiate
contact is a safeguarding decision (Q6). `messaging.manage` lets a moderator
remove people from groups and channels; it never grants access to one. See
[messaging.md §9](messaging.md).

**Notifications add no permission.** Every `/notifications` route is
`@Authenticated()`: an inbox, its read state, notification preferences and
push devices are inherent to having an account. What keeps them safe is
scope — every use case acts on the principal's own id, no request can name
another account, and another person's notification or device answers `404`
like one that does not exist. **A notification is never a grant:** its target
is an address, and opening it goes through the owning module's ordinary
authorization (someone removed from a conversation keeps the notification
about it, and gets `messaging.conversation_not_found` when they tap it). Who
is notified at all is messaging's answer — members who may read the
conversation now — never a role, organisation or permission broadcast. See
[notifications.md §15](notifications.md#15-authorization).

A permission exists in three places, and they cannot drift apart silently:
the TypeScript catalogue, the `permissions` table (seeded by migration), and
every route declaration. A test compares the table to the catalogue, and the
architecture test refuses any route requiring a permission that is not in the
catalogue.

`isPermission()` guards every permission read from storage or a request.
`PolicyAuthorizationService.can()` returns `false` for an uncatalogued
permission **before any rule runs**, so no rule, however it is written, can
grant a permission that does not exist. Tested.

---

## 3. Roles — six active

`OWNER`, `ADMIN`, `SUPERVISOR`, `TEACHER`, `ASSISTANT_TEACHER`, `STUDENT`.

Parent, Auditor, Content Manager and Support are **not active**. The brief
names them as future roles. Activating one means deciding what it may see, and
that has not been decided. The Foundation defined all ten; the migration
removes assignments of the four inactive ones.

**Adding a role is a migration, not a code change.** Assignment is validated
against the `roles` table, and a role's permissions come from
`role_permissions`, so a role inserted by migration is assignable and effective
without a deploy. Nothing in code enumerates roles to make a decision.

**OWNER is not ADMIN.** They are separate roles. Nothing may assume one implies
the other, and the institution may separate them further.

---

## 4. The role matrix — PROVISIONAL

Not confirmed by the institution (Q1). It exists so the system is usable and
testable meanwhile, and it is kept in one file so nobody mistakes it for policy.

| Role | Provisional grants |
| --- | --- |
| OWNER | all 30 |
| ADMIN | all except `settings.manage` and `messaging.manage` (28) |
| SUPERVISOR | read access: `users`, `people`, `academic`, `attendance`, `assignments`, `reports`, `messaging.read/send/start_direct/create_group`, `live.join`, `files.read` |
| TEACHER | `people.read`, `academic.read/teach`, `attendance.*`, `assignments.read/manage`, `messaging.read/send/start_direct/create_group`, `live.join/speak/moderate`, `files.*` |
| ASSISTANT_TEACHER | `academic.read/teach`, `attendance.read`, `assignments.read`, `messaging.read/send`, `live.join`, `files.read` |
| STUDENT | `academic.read/study`, `assignments.read/submit`, `messaging.read/send`, `live.join/raise_hand`, `files.*` |

Two **technical** constraints shaped it. These are not policy choices:

1. **ADMIN must hold what the roles it onboards hold.** The no-escalation rule
   (§7) lets you grant only permissions you already have. An ADMIN lacking
   `live.moderate` could not create a TEACHER.
2. **OWNER must differ from ADMIN by at least one permission.** If the two were
   equal, no-escalation would let any admin reset an owner's password and sign
   in as them. `settings.manage` is that difference, as the one permission in
   the brief's list about governing the system itself.

`messaging.manage` is also withheld from ADMIN: it is power over other people's
private conversations, and it should not be granted by default beyond the
owner (Q6).

Students may **ask** for the floor (`live.raise_hand`) but never **take** it
(`live.speak`) or **give** it (`live.moderate`). Tested, because a
2500-listener room depends on it.

The matrix is seeded into `role_permissions` by migration, and the **table is
what runs**. A test fails if the constant and the seeded rows disagree. When the
institution confirms its matrix, it becomes a reviewed migration. Changing it
at runtime through an admin API is deferred; its audit action,
`identity.role_permissions.changed`, is already reserved.

---

## 5. Resource-scoped rules

```ts
interface PolicyRule {
  appliesTo(permission, context): boolean;          // cheap pre-filter
  evaluate(principal, permission, context): 'permit' | 'deny' | 'abstain';
}
```

Three-valued on purpose: `abstain` is not `deny`. A rule with no opinion must not
veto a permission granted elsewhere.

**Combination — deny-overrides:**

```ts
if (!isPermission(permission)) return false;             // not a permission at all
if (decisions.includes('deny')) return false;             // an explicit deny always wins
if (principal.permissions.has(permission)) return true;   // role baseline
return decisions.includes('permit');                      // a rule may still grant
```

**Provisional rule in force: host-only moderation.** Holding `live.moderate`
means "may moderate rooms you host", not "may moderate any room". Given the
room's host in context, the rule *abstains* for the host (the role baseline
decides) and *denies* everyone else, **including OWNER**. Whether a supervisor,
admin or owner may step into someone else's room is Q1.

When no owner is supplied, the rule does not apply. That is what lets a use
case ask the coarse question, "may this principal moderate at all?", before it
loads the room.

> **Proposed change:** see
> [communities-live-attendance.md §8](communities-live-attendance.md#8-authorization-model)
> (design only,
> [ADR 0017](decisions/0017-community-scoped-authorization.md) Accepted).
> Inside a community, a decision would be identity's role-wide ceiling AND
> the principal's standing in that community. The communities module would
> hold that standing (owner, member, and capabilities the owner delegates)
> and answer through `COMMUNITY_AUTHORIZATION`. Identity would get no
> per-resource grants. The host-only rule above would be retired in the
> change that moves live moderation to community standing (phase P6),
> leaving `PROVISIONAL_POLICY_RULES` empty. Who may moderate stays open:
> [Q54](open-questions.md#q54--who-starts-ends-and-moderates-a-live-session)
> and [Q1](open-questions.md#q1--what-may-each-role-actually-do).

---

## 6. Enforcement — at the edge, and again in the use case

### At the HTTP edge: one guard, three declarations

Every route declares **exactly one**:

| Declaration | Means |
| --- | --- |
| `@PublicRoute()` | No authentication; the token is not even looked at |
| `@Authenticated()` | A live principal is required; no particular permission |
| `@RequirePermission(p)` | A live principal holding `p` is required |
| *nothing* | **403 to everyone**: fail closed |

`AccessGuard` does authentication and authorization in one place, in a fixed
order. The Foundation used two guards whose order depended on provider
registration order. The guard contains no rules; it reads the declaration and
asks.

`@Authenticated()` is for acts inherent to having an account: who am I, sign me
out, my devices, my password, my notifications. Making those grantable would
allow a role that cannot log out.

Only four routes are public: login, refresh, and the two health probes. The
architecture test fixes that list; adding to it is an argued change.

> **Correction (2026-09-23):** six routes are public, not four. Besides
> login, refresh and the two health probes, the local storage adapter's
> upload and download routes are `@PublicRoute()`
> (`files/infrastructure/local-transfer.controller.ts:48, 108`). Their
> authorization is a purpose-bound signature in the URL, which expires
> (`:30-33`). The architecture test fixes all six
> (`test/architecture/authorization.spec.ts:129-136`).

### In the use case: always

A guard sees a route and a principal, not the resource. And a use case may be
called by a job, an event handler or an automation rule, none of which pass
through a guard. So **every sensitive use case authorizes itself**, with the
resource in context:

```ts
// live/application/moderate-speaker.use-case.ts
const allowed   = authorize(principal, Permissions.live.moderate);           // coarse, before loading
// … load request → session → room …
const inThisRoom = authorize(principal, Permissions.live.moderate, {
  resourceType: 'live.session', resourceId: session.id, ownerUserId: room.hostUserId,
});
```

The coarse check runs **before** anything is loaded, so a caller without the
permission cannot use error messages to learn which resources exist. Tested
across the admin use cases: a denied caller's error is identical for a real
account and a missing one.

**This was a real gap in the Foundation.** `ModerateSpeakerUseCase` checked the
permission without the room, so any teacher could moderate any room. It now
asks identity with the host in context, and the test uses the *real*
authorization service, not a permissive stub.

### System principals

Work nobody is logged in to do, such as a scheduled job or an automation rule,
acts as a **system principal**:

```ts
const importer = systemPrincipal('student-import', [Permissions.users.manage]);
```

It holds exactly the permissions it is given. A use case authorizes it with the
same call it uses for a person. Tested: an importer that may create accounts
cannot assign roles.

---

## 7. Administration invariants — security, not policy

These hold whatever the institution decides roles may do:

| Invariant | Prevents |
| --- | --- |
| **No escalation** — administer only accounts whose permissions ⊆ yours; grant only roles whose permissions ⊆ yours | an admin resetting an owner's password; granting OWNER to an account you control |
| **No self-administration** — status, roles and password reset cannot target your own account | locking yourself, possibly the last owner, out |

Together: the API can never lose its last fully-privileged account. To act on
such an account you must hold everything it holds, and you cannot act on
yourself, so another equally privileged account always remains. Each is
tested.

---

## 8. What other modules may use

From `identity/contracts/` only (enforced by dependency-cruiser and a dedicated
test):

- `AUTHORIZATION_SERVICE` / `AuthorizationService` — `can()` and `authorize()`
- `Permissions`, `Permission`, `isPermission`
- `RequirePermission`, `Authenticated`, `PublicRoute`
- `Principal`, `systemPrincipal`

Identity's tables are private. No file outside identity imports its schema,
which is asserted by test.

---

## 9. What is tested

| Property | Where |
| --- | --- |
| Granted / denied / unknown permission / empty principal | `authorization.service.spec.ts` |
| Deny-overrides, abstain does not veto, rules scope but never grant | `policy.spec.ts` |
| Host-only moderation — including against an all-permission principal | `authorization.service.spec.ts`, `moderate-speaker.spec.ts` |
| Catalogue: unique, well-formed, covers the brief's namespaces | `permissions.spec.ts` |
| Matrix: only catalogued permissions; OWNER ⊋ ADMIN; ADMIN ⊇ roles below; student cannot speak | `role.spec.ts` |
| DB catalogue, roles and matrix equal the code | `test/integration/identity-persistence.spec.ts` |
| No escalation; no self-administration; existence not leaked | `provisioning.spec.ts` |
| System principals held to their grants | `authorization.service.spec.ts`, `provisioning.spec.ts` |
| Guard fails closed; public skips tokens; 401 vs 403 | `access.guard.spec.ts` |
| Every discovered route declares exactly one access level; public set fixed; admin routes need a permission | `test/architecture/authorization.spec.ts` |
| Every notification route is `@Authenticated()`; another person's notification or device is `404`; a notification's target is refused after removal | `test/architecture/authorization.spec.ts`, `test/api/notifications.api.spec.ts` |
| Every academic route holds `academic.read` or `academic.manage`; a teacher reaches a halaqa's roster only through an ACTIVE assignment to it, a student only their own record | `test/architecture/authorization.spec.ts`, `academic/application/access.spec.ts`, `test/api/academic.api.spec.ts` |
| 401 / 403 / validation / error shape over real HTTP | `test/api/identity.api.spec.ts` |

*Correction to the Foundation document:* it listed catalogue and deny-override
properties as tested by `test/architecture/authorization.spec.ts`. That file
tested route annotations only, and did so from a hand-maintained list of
controllers. It now discovers controllers from the source tree, and the other
properties have the tests above.

---

## 10. Deferred

- Runtime editing of the role → permission matrix (audit action reserved).
- Scoping by guardianship, and scoping attendance and assignments by halaqa:
  policy rules the mechanism supports but the institution has not defined.
  Academic's own reads are already scoped by halaqa — through teaching
  assignments, in academic's use cases.
- What supervisors may see of academic records (Q31).
- Field-level authorization.
- Delegation and time-boxed grants ("acting supervisor until Friday").
