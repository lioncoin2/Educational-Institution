# Authentication

**State: implemented and tested** — Identity & Access V1. What is provisional
is marked as such, and collected in [open-questions.md](open-questions.md).

Authentication answers one question: *who is this?* What they may then do is
[authorization.md](authorization.md). How a signed-in device stays signed in —
and stops being signed in — is [session-management.md](session-management.md).

---

## 1. The endpoints

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/login` | public, rate-limited | Sign in on one device |
| POST | `/auth/refresh` | public, rate-limited | Exchange a refresh token for a new pair |
| POST | `/auth/logout` | authenticated | End this device's session |
| GET | `/auth/me` | authenticated | The caller's account |
| GET | `/auth/sessions` | authenticated | The caller's signed-in devices |
| DELETE | `/auth/sessions/:id` | authenticated | Sign one of your devices out |
| POST | `/auth/password` | authenticated, rate-limited | Change your own password |

Account provisioning is a **separate controller** under `/admin/users`, behind
separate permissions — see §6. There is no registration endpoint.

---

## 2. Sign-in

```
POST /auth/login
{ "identifier": "teacher@institution.org", "password": "…",
  "identifierType": "email",                        ← optional, default "email"
  "device": { "platform": "ios", "label": "Amina's iPhone", "appVersion": "1.2.0" } }

200 { "tokenType": "Bearer", "accessToken": "…", "expiresIn": 900,
      "refreshToken": "<sessionId>.<secret>", "refreshTokenExpiresAt": "…",
      "sessionId": "…", "user": { "id", "displayName", "status", "roles", "permissions" } }
```

What happens, in order (`LoginUseCase`):

1. **Normalize the identifier** (NFC, trim, lower-case). One place does this,
   and every read and write goes through it.
2. **Throttle per account** — 10 attempts per 15 minutes per identifier. The
   counter key is a *hash* of the identifier, so the limiter's store never
   holds an address.
3. **Look the account up.** If there is none, run a full password verification
   against a real hash anyway, so the two paths take the same time.
4. **Verify the password** — scrypt, constant-time comparison.
5. **Only now** check the account state. A suspended account's owner learns it
   is suspended; a guesser with the wrong password learns nothing.
6. **Open a session** for this device, and issue the tokens.

### Failures that must be indistinguishable

| Situation | Response |
| --- | --- |
| No such account | 401 `identity.invalid_credentials` |
| Wrong password | 401 `identity.invalid_credentials` — identical body |
| Right password, account PENDING | 403 `identity.account_pending` |
| Right password, account SUSPENDED | 403 `identity.account_suspended` |
| Right password, account DISABLED | 403 `identity.account_disabled` |
| Too many attempts | 429 `identity.too_many_attempts` + `Retry-After` |

An unknown account and a wrong password are identical in body *and* in timing —
both are tested. The account-state errors are safe because they are only ever
returned to someone who has just proved they know the password.

### Password rules apply when a password is *set*, never when it is *used*

The login endpoint accepts any password up to 1024 characters. It does not
apply the password policy: an old password must keep working after a policy
change, and a login form that answers "too short" has confirmed the policy to
someone who did not know it. A one-character password gets 401, like any other
wrong one — tested.

---

## 3. Passwords

Behind the `PasswordHasher` port; implemented by `ScryptPasswordHasher` on
Node's built-in scrypt. The Foundation implementation was kept — there was no
engineering reason to change it — and hardened:

- **Format** `$scrypt$N$r$p$salt$hash`, carrying its own parameters, so the cost
  can be raised without invalidating existing hashes.
- **Current cost** N=16384, r=8, p=1, 16-byte salt, 32-byte key.
- **Upgrade on login.** `needsRehash()` spots a hash made with weaker parameters;
  a successful login re-hashes the same password. That is not a password change:
  `passwordChangedAt` stays put and no session ends.
- **Constant-time comparison** (`timingSafeEqual`), verified by test.
- **Constant work in every failure mode.** A malformed stored hash still costs a
  full hash at today's parameters.
- **Stored hashes are treated as data, and data can be corrupt.** Parameters
  read back are bounds-checked — N a power of two in [2¹⁰, 2²⁰], r ≤ 32, p ≤ 16.
  Without that, a corrupted row could make verification throw (a 500 that
  differs from a wrong password) or ask scrypt for gigabytes of memory. The
  Foundation implementation accepted `N=0`; it no longer does.

### New-password policy — PROVISIONAL

| Rule | Value | Source |
| --- | --- | --- |
| Minimum | 8 characters | NIST SP 800-63B's floor |
| Maximum | 128 characters | above NIST's "at least 64"; bounds hashing work |
| Whitespace-only | rejected | |
| Counting | characters, not UTF-16 units | so an Arabic passphrase counts as its owner would |

A breached-password check (NIST recommends one) is **not** implemented — Q14.

Passwords are never stored, logged or returned. The log redaction list covers
every password-bearing field at every depth, which is tested (see
[observability.md](observability.md)).

---

## 4. Access tokens

Behind the `TokenIssuer` port; `JwtTokenIssuer` is the only file that signs or
verifies one. No layer above infrastructure imports a JWT library.

### Claims — the minimum

```json
{ "sub": "<opaque user id>", "sid": "<session id>",
  "iat": 1790000000, "exp": 1790000900,
  "iss": "institution-api", "aud": "institution-clients" }
```

That is the entire payload, asserted by test. No email, no name, no phone, no
roles, no permissions.

Two reasons. Anything in a JWT is readable by whoever holds it and ends up in
client storage and logs. And anything in a JWT stays *true* until the token
expires, even after the fact behind it changes. The Foundation put roles in the
token and claimed revocation was immediate; it was not. Now the token carries
only the subject and the session, and roles and permissions are read from
storage on every request.

### Verification

- **Algorithm pinned** to HS256 on verify, so a token cannot choose its own:
  `alg: none` and HS512 are refused (tested).
- **Issuer and audience checked.**
- **Expiry checked** against the injected clock.
- A valid signature is **necessary, not sufficient**: the token's session must
  still be live and the account still ACTIVE. See §5.

### Lifetime — 15 minutes

`JWT_ACCESS_TTL`, default 900 seconds. Short, but it is *not* the revocation
mechanism — sessions are. Because every request checks the session, a signed-out
or suspended user loses access on their next request, not 15 minutes later. The
short lifetime limits how long a *copied* token is useful to someone who does not
also hold the refresh token.

### The key

`JWT_SECRET`. In production it must be at least 32 bytes (RFC 7518 §3.2) and must
not be a known placeholder; the application refuses to boot otherwise. Key
rotation (`kid`) is deferred.

---

## 5. Every request: resolving the principal

`AccessGuard` → `ResolvePrincipalUseCase`, on every non-public request:

```
verify signature, alg, iss, aud, exp     ← the token is ours and current
session(sid) exists, belongs to sub,     ← not logged out, not revoked,
  not revoked, not expired                  not past its absolute end
account(sub) exists and is ACTIVE        ← not suspended or disabled since
roles ← storage; permissions ← roles     ← a revoked role is gone now
```

**Cost:** two primary-key reads per authenticated request; the role → permission
matrix itself is cached (30 s by default). **Buys:** logout, session revocation,
suspension, disabling and role removal all take effect on the next request. A
token that outlives the decision to revoke it is the failure mode this exists to
prevent. If this cost ever matters, a short cache belongs behind the repository
ports — not in the token.

---

## 6. Provisioning — accounts are created by staff

There is **no public registration**. The institution creates accounts:

```
POST /admin/users                 { displayName, identifier, initialPassword }  → PENDING
POST /admin/users/:id/roles       { role: "STUDENT" }
POST /admin/users/:id/status      { status: "ACTIVE" }                           → can sign in
```

| Endpoint | Permission |
| --- | --- |
| `GET /admin/users`, `GET /admin/users/:id` | `users.read` |
| `POST /admin/users` | `users.manage` |
| `POST/DELETE /admin/users/:id/roles…` | `roles.assign` |
| `POST /admin/users/:id/status` | `users.manage` |
| `POST /admin/users/:id/password` | `users.manage` |
| `DELETE /admin/users/:id/sessions` | `sessions.manage` |

Each use case re-checks its permission itself — the route guard is the coarse
gate, not the only one — and adds the two checks a route cannot express. Both
are security invariants, not institutional policy:

- **No escalation.** You may only administer an account whose permissions are a
  subset of yours, and only grant a role whose permissions you already hold.
  Resetting someone's password *is* signing in as them; without this rule, an
  admin could reset an owner's password.
- **No self-administration.** Status, roles and password reset cannot target your
  own account through the admin API — self-service has its own endpoints.

Together they guarantee the API can never lock out the last fully-privileged
account. To act on such an account you must hold everything it holds, and you
cannot act on yourself, so another equally privileged account always remains.

### The first owner — no seeded password

No account and no default credential exists anywhere in the repository. The
first OWNER is created by an operator, on the server:

```bash
npm run build
read -rs OWNER_PW && printf '%s\n' "$OWNER_PW" | \
  node dist/cli/bootstrap-owner.js --email owner@institution.org --name "Full Name"
```

The password is read from standard input, never from an argument or an
environment variable, either of which would leave it in shell history or `ps`.
The command refuses to run while any ACTIVE owner exists. It is a way in only for
an empty system, or for recovering one that has lost every owner, and only for
someone with shell access to the server, who could edit the database anyway.
Who that first owner should be is the institution's decision (Q2).

---

## 7. Identifiers — email today, not only email

Login identifiers live in `user_identifiers (kind, value)`, not in a column on
`users`. Email is the only kind today, but many learners at a Qur'an institution
are children without an address, and an institution-issued username or a phone
number are both plausible. Adding a kind means a union member, a normalizer, and
one migration widening a CHECK. Login, sessions and tokens do not change. The
API already carries `identifierType`.

---

## 8. Rate limiting

Behind the `RateLimiter` port (shared kernel), in two layers that stop
different attacks:

| Policy | Limit | Where | Stops |
| --- | --- | --- | --- |
| `auth.login.ip` | 30 / 5 min | HTTP edge (`@RateLimit`) | one source, many accounts |
| `auth.login.identifier` | 10 / 15 min | `LoginUseCase` | many sources, one account |
| `auth.refresh.ip` | 120 / 5 min | HTTP edge | refresh hammering |
| `auth.password.user` | 5 / 15 min | `ChangeMyPasswordUseCase` | a stolen access token used as a password oracle |
| `auth.password.ip` | 20 / 15 min | HTTP edge | |

**These are development-safe defaults, not a production policy.** They are
generous enough that a person never meets them by accident and tight enough
that online guessing is slow. Production numbers should come from observed
traffic.

- **Throttling, never lockout.** A lockout lets anyone who knows your email lock
  you out on demand. A successful sign-in clears that account's counter.
- **Per-account limits live in the use case**, so they hold whatever transport
  the attempt arrives through.
- **A refusal returns 429 with `Retry-After`.**
- **The in-memory limiter is per process.** With N replicas the effective limit
  is N × the limit; a Redis adapter behind the same port is the production path
  (deferred). Memory is bounded, and eviction can only make it more lenient.
- **Per-IP limits trust `TRUST_PROXY`.** Set it to match the deployment:
  trusting a proxy that is not there lets any client forge its address.

---

## 9. What the client holds

- The Flutter app holds **no secret**: no API key, and never the LiveKit
  secret. Live rooms are joined with a short-lived token minted per session.
- Tokens belong in platform secure storage (Keychain / Keystore). The
  `AuthRepository` contract in `app/lib/data/repositories/repositories.dart`
  states the rules its network implementation must follow.
- **Web** needs a different refresh-token transport before it goes live — an
  httpOnly cookie rather than script-readable storage. That is deferred: Q17.
