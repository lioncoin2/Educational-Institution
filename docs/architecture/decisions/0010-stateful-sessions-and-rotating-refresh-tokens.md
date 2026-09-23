# 0010 — Stateful sessions, checked per request, with rotating refresh tokens

**Status:** Accepted
**Date:** 2026-09-23

## Context

Foundation V1 issued a JWT carrying the user id **and their roles**, verified
only its signature, and had no notion of a session. Its documentation claimed
role revocation was immediate. It was not:

- Revoking a role left it in every outstanding token until expiry.
- Suspending an account left its tokens working until expiry.
- Logout could not exist; there was nothing server-side to end.

Identity & Access V1 requires revocable refresh tokens with rotation and replay
detection, logout, per-device sessions, and suspension that means something.

## Decision

1. **A session per signed-in device** (`auth_sessions`), holding hashes of the
   current and previous refresh token and never a raw token.
2. **Access tokens carry only `sub` and `sid`** (plus `iat`, `exp`, `iss`,
   `aud`). No roles, no permissions, no personal data.
3. **Every authenticated request re-resolves the principal**: the token's
   session must be live, the account ACTIVE, and roles are read from storage.
   The role → permission matrix is cached briefly; the user's roles are not.
4. **Refresh tokens rotate on every use.** Presenting the *previous* token means
   it was copied, so the session ends. Presenting an unknown secret for a real
   session id changes nothing, so a session id alone cannot sign anyone out.
5. **Rotation is a compare-and-swap** in the database. Two concurrent refreshes
   with one token cannot both succeed, and the loser is treated as reuse.

## Consequences

**Good.**
- Logout, device sign-out, password change, suspension, disabling and role
  revocation take effect on the next request, not at token expiry. All are
  tested end to end over HTTP.
- A stolen refresh token is detected the moment both parties use it, and both
  lose the session.
- A database dump does not allow refreshing; only hashes are stored.
- Tokens reveal nothing about the person holding them.

**Bad, and accepted.**
- **Two primary-key reads per authenticated request** (session, account). That
  is the price of revocation that works. If it ever matters, a short cache
  belongs behind the repository ports, with a bounded staleness that is written
  down, not back in the token.
- **Strict rotation constrains clients.** A client that refreshes twice at once
  signs itself out. The Flutter `AuthRepository` contract requires single-flight
  refresh. A grace window was considered and rejected for now (Q16).
- Sessions are state that must be stored, indexed and eventually cleaned up.

## Alternatives considered

**Stateless JWTs with roles, short TTL.** The Foundation design. Rejected: no
logout, and suspension and role changes lag by up to the TTL, while the
documentation promised otherwise.

**A token denylist in Redis.** Makes logout work, but not suspension or role
changes, since the roles are still in the token. It also puts security state in
a store that may be flushed (persistence.md: Redis never holds business truth).

**Opaque access tokens looked up on every request.** Equivalent in cost to this
design and simpler to revoke, but it loses the cheap, local signature check that
rejects garbage and expired tokens before any database read. It also forces
every future service extracted from the monolith to call identity on every
request. JWT + session check keeps both options open.

**Refresh-token families (a table of every token ever issued).** Detects replay
of any old generation, not just the previous one. Rejected as unnecessary: a
token older than the previous one gives an attacker no live branch, since it is
already refused, and storing only current and previous handles the case that
matters, a fork.
