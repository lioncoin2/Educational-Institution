# Session Management

**State: implemented and tested** — Identity & Access V1.

A session is one signed-in device. It is what a refresh token belongs to, and
what every access token is checked against on every request.

```
User
 ├── Session A   iPhone     created 1 Sep   last used today
 ├── Session B   iPad       created 3 Sep   last used 5 Sep
 └── Session C   Web        created 9 Sep   last used 1 h ago
```

---

## 1. The model

`AuthSession` (`identity/domain/auth-session.ts`), table `auth_sessions`:

| Field | Purpose |
| --- | --- |
| `id` | Session identity; also the first half of the refresh token |
| `user_id` | Whose session (FK, cascades on account deletion) |
| `refresh_token_hash` | SHA-256 of the refresh token that may be used **next** |
| `previous_refresh_token_hash` | SHA-256 of the one it replaced — for reuse detection |
| `generation` | How many rotations so far. Diagnostic only |
| `device_platform` / `device_label` / `app_version` | What the client says it is |
| `created_at` / `last_used_at` | Shown to the user |
| `expires_at` | **Absolute** end. Refreshing never extends it |
| `revoked_at` / `revoked_reason` | Set once, never cleared |

### Never a raw token

The table stores hashes of refresh tokens and nothing from which a token could
be rebuilt. A copy of the database is useless for refreshing. The API tests and
the Postgres tests both search the stored rows for the secret half of the
issued tokens, and find nothing.

The secret is 256 random bits, so SHA-256 is the right tool. There is nothing
to brute-force, and a slow KDF would only make every refresh slower.

### Device metadata — deliberately little

Platform (`ios`, `android`, `web`, `unknown`), a label the client supplies
("Amina's iPhone"), and an app version. That's all. These are self-declared,
never trusted for a decision, and cleaned before storage: control characters
removed, whitespace collapsed, length capped.

**Not stored:** IP address, user-agent string, hardware identifiers. Those would
turn a list of your devices into a fingerprinting database, and a person can
recognize "Amina's iPhone" without them. IP addresses do appear in the *audit*
trail for authentication events (see [authentication.md](authentication.md)),
where they are a security signal, not a session attribute.

---

## 2. The refresh token

Wire format: `<sessionId>.<secret>`, where the secret is 32 random bytes in
base64url (43 characters).

- The **session id** makes lookup a primary-key read. It is not secret.
- The **secret** proves possession. Only its hash is stored.
- Parsing is **strict**: two parts, exact alphabets, exact secret length.
  Anything else is rejected before it reaches storage or a hash function.

---

## 3. Rotation, and what a replay means

Every refresh issues a **new** refresh token and retires the presented one:

```
presented == current     →  issue a new pair; current becomes previous
presented == previous    →  REUSE. End the session.
anything else            →  reject; change nothing
```

**Why the second case ends the session.** A refresh token that has been
rotated should never be presented again. If it is, two parties held it — the
owner and someone who copied it — and the server cannot tell which one is
asking. Ending the session cuts off both. The owner signs in again; the thief
cannot.

That covers both orders:

| First to refresh | Then | Result |
| --- | --- | --- |
| Owner (T₁ → T₂) | Thief presents T₁ | T₁ is "previous" → session ended; T₂ dies too |
| Thief (T₁ → T₂′) | Owner presents T₁ | T₁ is "previous" → session ended; T₂′ dies too |

**Why the third case does *not* end the session.** A session id alone proves
nothing. If a forged secret on a real session id ended that session, anyone who
saw an id — in a log, in a bug report — could sign its owner out at will.
Reaching the second case requires a secret that was once valid. The forged case
is rejected and audited, and the session lives on (tested).

### Concurrent refreshes

Rotation is a single conditional `UPDATE … WHERE refresh_token_hash = <expected>
AND revoked_at IS NULL`. Two refreshes racing on one token cannot both succeed.
The loser's token is, by the time its update runs, the *previous* token, so it
is treated as reuse and the session ends. Tested on both adapters.

**This is strict on purpose, and it constrains the client.** A client that fires
two refreshes at once will sign itself out. The Flutter `AuthRepository`
contract requires refreshes to be single-flight. A grace window, where a
just-retired token would be refused *without* ending the session, is a known
trade-off. It is not implemented: it would help only badly behaved clients, and
would open a window in which a stolen token is replayed without detection.
Reconsider only if telemetry shows real users being signed out (Q16).

---

## 4. Lifetimes

| | Default | Setting | Notes |
| --- | --- | --- | --- |
| Access token | 15 min | `JWT_ACCESS_TTL` | Not the revocation mechanism |
| Session (absolute) | 30 days | `REFRESH_SESSION_TTL_SECONDS` | Never extended by refreshing |
| Idle timeout | none | — | Q16 |

Both defaults are **provisional**. Thirty days means a student who opens the
app weekly is not asked for a password every time; an institution may want
shorter, especially for staff roles or shared devices. There is no idle timeout
today. With one, a student returning after the summer break would have to sign
in again, and whether that is desirable is the institution's decision (Q16).
The application refuses to boot if the session is not longer than the access
token.

---

## 5. How a session ends

| Event | Which sessions | `revoked_reason` |
| --- | --- | --- |
| `POST /auth/logout` | this one | `logout` |
| `DELETE /auth/sessions/:id` (own) | that one | `revoked_by_user`, or `logout` if it is this one |
| `POST /auth/password` | all **other** sessions | `password_changed` |
| `POST /admin/users/:id/password` | all of the account's | `password_reset` |
| `DELETE /admin/users/:id/sessions` | all of the account's | `revoked_by_admin` |
| Account suspended | all | `account_suspended` |
| Account disabled | all | `account_disabled` |
| Refresh finds the account inactive | that one | `account_inactive` |
| A retired refresh token is presented | that one | `refresh_token_reuse` |
| `expires_at` passes | — | (not revoked; simply expired) |

**Every one of these takes effect on the next request**, because every request
re-checks the session (see [authentication.md §5](authentication.md)). None of
them waits for the access token to expire. This is tested end to end: the API
suite signs a student in, suspends them, and the very next request with the
same unexpired access token is refused.

Revocation is idempotent and one-way. Revoking a revoked session keeps the
first time and reason, and no code path clears `revoked_at`. The Postgres
adapter enforces this in the `UPDATE`'s `WHERE` clause, and a CHECK constraint
refuses a revocation without a reason.

Changing your own password spares the device you are holding and ends the
rest. If the password is being changed because someone else knows it, their
devices must stop working now, while yours stays signed in.

---

## 6. Listing and revoking devices

```
GET /auth/sessions
200 { "items": [ { "id": "…", "device": { "platform": "ios", "label": "Amina's iPhone",
                   "appVersion": "1.2.0" }, "createdAt": "…", "lastUsedAt": "…",
                   "expiresAt": "…", "current": true }, … ] }

DELETE /auth/sessions/:id      → 204
```

- Only live sessions are listed: not revoked, not expired. Most recently used
  first.
- `current` marks the device the request came from.
- No hash, token or security field appears in the response (tested).
- **Another person's session is reported exactly like a missing one** (404
  `identity.session_not_found`), so the endpoint cannot be used to discover
  session ids. Tested.

These need no grantable permission. Managing your own devices is inherent to
having an account, and a role that could not sign itself out would be absurd.
They are declared `@Authenticated()`, and every use case scopes itself to the
principal's own user id.

---

## 7. Growth

Revoked and expired rows are kept; nothing deletes them yet. A partial index
(`WHERE revoked_at IS NULL`) keeps the hot queries, listing and ending a user's
live sessions, off the dead rows. A cleanup job is deferred to `automation`,
and how long session history is kept is part of the retention question (Q3).
