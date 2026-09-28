# P7.2 — Real LiveKit media integration: audit

**Date:** 2026-09-28. **Repository state:** `95ffbf6`. **Scope:** the read-only audit that brief
§1 requires before any change. No file outside this document was changed.

**Verdict at the end: P7.2 STOPPED at the audit, on one decision (§2).**

The application-side media integration the brief describes is already built, and it works on
the pinned server:
- real tokens through the provider port;
- roles and presenter policy;
- lifecycle and Communities authorization;
- the reconciler.

That is P6 plus P7.1. What is left is mostly tests, observability, the error model and a few
hardening fixes (§3, §7, §11).

But the audit found a hole, and a probe on the pinned v1.13.7 server reproduced it (§2.2). A
speaker whose floor is revoked can keep publishing indefinitely. So can a demoted presenter or a
removed member who could publish. They do it through LiveKit's `#`-suffixed identities, because
the server gives every new connection a fresh ten-minute token.

The approved rule removes such identities but never escalates (P7.1 decision 6). So "a
previously issued token must not become a permanent authorization grant" (§11) does not hold.
Closing the hole means amending an approved decision. Brief §28 says: stop, report, and do not
invent policy.

---

## 0. Method

- **Nine agents.**
  - Seven auditors covered the brief's 15 areas: the Live domain and application, the provider
    port and LiveKit adapter, the reconciler, Communities and identity, platform, tests, and the
    client contract.
  - Two adversarial verifiers followed. The first re-read every unsafe, contradiction, stop and
    must-change claim against the code and the pinned LiveKit source; it confirmed all 14. The
    second re-read the tests behind each of the 26 matrix items and corrected three labels (§7).
  - Every claim cites file and line. The agents' reports are not committed.
- **One throwaway probe** on the pinned server (§2.2). It ran on loopback, used the committed
  `livekit.yaml` and a random key, and is not committed.
- **Test categories use the brief's letters:**
  - **A** unit: domain, use cases and HTTP over the fake or disabled provider;
  - **B** provider adapter: the real adapter and SDK against mocks or a stub;
  - **C** real local LiveKit: the pinned v1.13.7 server and `@livekit/rtc-node`;
  - **D** production deployment.

  P7.1's record used other letters: its C (fake provider) is A here, its D (real LiveKit) is C
  here, and its E (deployment files) is static and part of none.
- **Sources.** **SRV** is LiveKit server v1.13.7 (`8d11efd`), and **ICE** is `livekit/ice`
  v4.4.0-warp.2. Repository paths are from the root, and `live/…` means
  `backend/src/modules/live/…`.

## 1. The current state

- **Roles and capabilities** (`live/domain/standing.ts:39-58`, `live/application/live-standing.ts`).
  Standing is recomputed on every join, push and sweep, never cached and never taken from the
  client.
  - Microphone: a granted hand, or a moderator holding `live.speak`.
  - Screen: presenter AND `live.speak` (P6 decision 1).
  - Always: screen audio, data and `hidden` off, subscribe on.
  - The wire roles are `moderator` > `speaker` > `listener`.
- **Token** (`live/application/join-live-session.use-case.ts`,
  `live/infrastructure/livekit-rtc-provider.ts:183-208`). `/join` is the only issuer and takes
  nothing but the session id.
  - identity: the account id;
  - name: the account directory's;
  - room: the stored session's `<prefix><id>[.<epoch>]`;
  - lifetime: 120 s, bounded 1–600 at both ends;
  - grants: explicit publish sources; never `roomCreate`, `roomAdmin` or `roomList`.
  - The ticket is `{token, url, expiresInSeconds, role, media}`, and `url` is the client
    `LIVEKIT_URL`.
- **Lifecycle** (`live/domain/live-session.ts`).
  - States are `live | ended`; the brief's STARTED/ACTIVE/ENDED differ only in naming.
  - End expires every hand and the presenter grant under the session lock, then ends the room.
    `auto_create=false` keeps an ended room gone, and a missing room is never turned into a
    session.
- **Authorization.** Every `/join` asks Communities, through its contracts only. Unknown,
  non-member, another community and removed all answer the same 404 (no enumeration). An outage
  answers 503. LOCKED keeps join, raise and moderation open and refuses only Start (Q46,
  PROVISIONAL).
- **Reconciler.**
  - Room sweep: 60 s, gated on readiness.
  - Participant sweep: 60 s.
  - Watch: every 10 s for 660 s after a correction or removal.
  - Enforcement: breach, then correction, then a violation, then a media reset (epoch + 1) on
    the second offence.
  - `ProtectLiveSessions` accelerates on Communities facts.
  - Foreign `#` identities are removed at once.
- **Boundaries.** The SDK is imported only in `live/infrastructure/livekit-*.ts`, and
  `@livekit/rtc-node` only under `backend/test/livekit/`. Both are enforced by dependency rules
  and `live-boundaries.spec.ts`.
- **Real suite (C):** 6 files and 36 tests, green on GitHub (CI runs #50 to #53). It proves 9 of
  the 26 matrix items fully and 12 in part (§7).

## 2. The STOP

### 2.1 Mechanism, from the pinned source

1. **Any publish-capable token can add a second participant.** A client connecting with
   `?publish=<x>` joins as `<identity>#<x>`, with the token's publish rights (SRV
   `pkg/service/utils.go:377-387`, gated only by `canPublish`). No server option disables this;
   a listener's token is refused (401).
2. **The server hands every connection a fresh token.** It sends it at once on join, then every
   five minutes, and on every permission change. The token is built from the participant's
   current grants and is valid max(10 min, time left) (SRV `pkg/service/roommanager.go:62-63,
   621-626, 764-765, 1146-1178`). A `<id>#<x>` connection therefore receives a new
   publish-capable token for `<id>#<x>`.
3. **Revocation of issued tokens is not honoured.** The server never reads `revoke_token_ts`
   (no reference in `pkg/` or `cmd/`), so removing a participant does not stop that token from
   connecting again.
4. **The application removes foreign identities but never escalates** (P7.1 decision 6;
   `live/application/live-reconciler-foreign.ts:16-20`). They are "never a violation — so never
   a media reset". The watch matches exact names, so a new suffix on each return is found only
   by the 60 s participant sweep.

So a speaker whose floor was revoked keeps a publish-capable token: the `/join` ticket, or the
last server refresh, which is at most 5 minutes old and valid for 10. They connect as `<id>#x`,
get a fresh 10-minute token, are removed within 60 s, and reconnect with it. Nothing ends the
chain. The same holds for:
- a presenter whose slot closed (for the screen);
- a moderator who lost `live.speak`;
- a member removed while they could publish.

A listener cannot start the chain, because the server refuses its token with `publish`. The
issued identity itself is bounded: a second offence resets the room, and the old room's tokens
die with it.

### 2.2 Reproduced on the pinned server

The probe (`livekit-server` 1.13.7, archive sha256 `6634aeeb…90e2`, the committed policy file)
issued one ticket as `/join` issues it for a speaker: identity `u1`, 120 s, microphone only.
Then it chained reconnects, each time with the token the server had pushed on the previous
connection, and removed the participant as the reconciler would:

| t (s) | Connected with | Outcome | What the server pushed |
| --- | --- | --- | --- |
| 0 | the ticket, plus `?publish=x` | admitted as `u1#x`, holding the microphone | a token for `u1#x`: microphone, valid 600 s |
| 200 | the token pushed at t=0 | admitted as `u1#x`, microphone | a new token, valid 600 s |
| 400 | the token pushed at t=200 | the same | the same |
| 600 | the token pushed at t=400 | the same | the same |
| 800 | the token pushed at t=600 | the same | the same |
| 802 | `@livekit/rtc-node`, with the token pushed at t=800 | **published a microphone track**; the server lists `u1#x` with it | — |

Each connection was removed through the room API right after it joined, as the reconciler
would. Every individual token is bounded: the original ticket was refused from t=200 (401), and
the first refreshed token was refused at t=800 (401). The chain is not bounded. At 13 minutes the
identity still publishes. By then it is past the ticket's 180 s, past every token issued before
the revocation, and past the 660 s enforcement window. Against the real application, each link
would last until the reconciler's next pass (a 10 s watch, or the 60 s sweep for a new suffix),
so the publishing comes in bursts rather than continuously; it never ends.

### 2.3 Why the approved design does not bound it

P7.1 kept foreign identities out of the violation path, because a reset "would punish the whole
room and could not stop a publisher who may join again" (`live-reconciler-foreign.ts:16-20`).
That holds for an account still entitled to publish, which can always rejoin. It does not hold
for an account whose rights were withdrawn: a reset moves the room to a new name, and every
token for the old room, refreshed ones included, then reaches nothing. P7.1 recorded that the
server refreshes a connection's token "at once and every five minutes". It did not draw the
consequence for `#` identities: each foreign connection is handed a fresh token of its own, which
is what makes the chain self-renewing. It also missed the refresh on every permission change.

### 2.4 The decision needed

| Option | What changes | Cost |
| --- | --- | --- |
| **R1** (recommended) | A foreign identity whose base account (the id before `#`) may not currently publish what the connection holds counts as that account's breach. The first sighting removes it and arms a watch on the **base account**, matching every suffix. A second sighting inside the window resets the room (epoch + 1). Foreign identities of an account still entitled to publish stay as today: removed, never a violation | Amends P7.1 decision 6. A reset makes everyone rejoin through `/join`, but only after a withdrawn publisher has come back twice |
| R2 | Reset the room on every revoke, presenter close, demotion and removal of a publisher | Every revoke disrupts the whole room. Amends live.md §11.4 and Q63 |
| R3 | The TLS terminator strips `publish` from `/rtc` requests | Production-only (P7.1.1 is BLOCKED). Not locally testable. Defence in depth, not a fix |

**Recommendation: R1 now, R3 at deployment.** R1 is additive inside the existing reconciler and
uses existing port calls. It ends the chain for withdrawn publishers and leaves entitled ones
alone.

It comes with widening the enforcement window. Today it is 660 s = 600 (refresh) + 60 (sweep),
which leaves no margin for the server's 60 s expiry leeway (`live/domain/live-limits.ts:66-72`).
The proposal is 720 s = 600 + 60 + 60. That is a Q63 PROVISIONAL bound and needs your
acknowledgement.

## 3. Other questions P7.2 must settle

Most items in §4 follow the brief directly. These four conflict with an approved decision, so
they are yours:

| # | Question | Brief | Approved | Recommendation |
| --- | --- | --- | --- | --- |
| Q-A | Tell "not a member" (and "community locked", "insufficient capability") apart on the wire? | §15: differentiate | live.md §15.2: non-member ≡ unknown session, 404, so nobody learns a session exists. LOCKED does not refuse a join at all (Q46) | Keep the 404 on the wire. Add the reason to a structured `live.join.denied` log line (§17) |
| Q-B | How clients see provider failures | §15: unavailable, unauthorized, configuration failure, timeout | P7.1: one 503 `live.media_unavailable`, reasons in logs. At runtime, rejected credentials, TLS failures and wrong endpoints fall to an opaque 500 | Type the faults in the port (additive). On the wire, `503 live.media_unavailable` for unreachable or timed out (retryable), and a new `503 live.media_misconfigured` for credentials, TLS or a wrong endpoint (operator action). The exact kind goes in logs. `/join` keeps failing open on an outage (§11.5) |
| Q-C | Join-token lifetime from configuration | §20: no hardcoded TTL | `JOIN_TOKEN_TTL_SECONDS = 120`, a domain constant (Q63) | `LIVE_JOIN_TOKEN_TTL_SECONDS`, default 120, refused outside 1–600, checked where it is minted as today |
| Q-D | Enforcement window | — | 660 s (Q63) | 720 s (§2.4) |

## 4. What must change (after the decision)

**Security and correctness:**
1. R1, or the option you choose (§2.4).
2. Serialize `LiveMedia` pushes per (session, user). Pushes are not ordered today, so a racing
   grant and revoke can leave the microphone on until the watch corrects it
   (`live-media.ts:46-50` claims ordering the code does not give; brief item 23).
3. `LiveMedia.push` must push the listener set when the account is no longer eligible. Today it
   pushes `capabilitiesFor(standing)` regardless (`live-media.ts:206-212`).
4. `/join` asks Communities again after its provider round trips and immediately before minting
   the token, as Start does (D20). Today the permit can be a 10–20 s provider round trip old
   (brief §9).
5. Gate the participant sweep, the watch and `ProtectLiveSessions` on readiness, as the room
   sweep already is. A wrong endpoint answering `200 {}` otherwise drives phantom violations and
   resets (P7.1 decision 5, extended).
6. Put `/join`'s account-directory call behind the fail-closed wrapper. A non-database failure
   there is an opaque 500 today.
7. Refuse, in staging and production, a `LIVEKIT_URL` whose host is internal (loopback,
   single-label or RFC 1918). Every ticket hands that URL to clients (§14).

**Brief-directed additions:**
8. Ticket: add `sessionId` and an ISO `expiresAt` beside `expiresInSeconds`. Additive; the
   pinned body assertion is updated on purpose.
9. Structured logs, ids only (§17):
   - `live.join.admitted` and `live.join.denied`, with the internal reason;
   - `live.token.issued`: session, role, epoch, TTL; never the token;
   - `live.media.authorization_changed`: applied, not connected or pending;
   - `live.speaker.granted` and `live.speaker.revoked`;
   - `live.presenter.claimed` and `live.presenter.closed`;
   - a per-tick reconciliation summary.
10. Typed provider faults and the wire codes of Q-B.
11. Configurable join TTL (Q-C).
12. Docs: fix live.md §3.6 (screen = presenter && `live.speak`), the refresh description (add the
    refresh on every permission change and connection), the stale "start only" note on
    `live.media_unavailable`, and Q47's pointer.

## 5. Unsafe findings

| Severity | Finding | Where |
| --- | --- | --- |
| **High** | The self-renewing `#` chain (§2) | `live-reconciler-foreign.ts`; SRV `roommanager.go:764-765, 1146-1178` |
| Medium | A pre-revoke token lets the issued identity republish until the watch corrects it (≤10 s). The second offence resets the room. This is the bounded, approved residual | `live-reconciler-enforcement.ts`; live.md §11.4 |
| Medium | Removal is not final on the media plane: a removed member rejoins with a refreshed token until the next check. Bounded, approved | live.md:1127-1128 |
| Medium | Rejected credentials, TLS failures and wrong endpoints answer `/join` with an opaque 500 | `livekit-rtc-provider.ts:327-329`; `room-occupancy.ts:66-67` |
| Low | Grant and revoke pushes race on the wire | `live-media.ts:46-50` |
| Low | A push gives an ineligible account its granted microphone | `live-media.ts:206-212` |
| Low | `/join` mints on a permit up to 20 s old | `join-live-session.use-case.ts:120-152` |
| Low | Phantom enforcement behind a wrong endpoint | `live-reconciler-rooms.ts:66-69` only |
| Low | A join racing End mints a token for the room being deleted (accepted race; the room stays gone) | `live-races.spec.ts:615-633` |
| Low | `LIVEKIT_URL` may name an internal host in a deployed environment | `platform/config/livekit-config.ts` |
| Low | A timeout cannot be told apart from an outage | `livekit-transport.ts:96-97` |

## 6. Contradictions between the brief and the approved design

- **Resolvable.** Each is settled by §2.4, §3 or an additive change.
  - §11 vs P7.1 decision 6: the STOP.
  - §15 "not a member": Q-A.
  - §15 provider kinds: Q-B.
  - §20 TTL: Q-C.
  - §14 session id and expiry: additive.
  - §12 "the Docker configuration and digest" vs the real suite's sha256-pinned release binary
    (the same v1.13.7): keep the binary suite, and add a local run of the pinned image by digest.
    Docker 29.3.1 is installed here.
  - §24 "0 skipped" vs `describeWithPostgres`: run the validation with Postgres, as CI does.
- **Naming only.** The behaviour already matches in each:
  - STARTED/ACTIVE/ENDED vs `live | ended`;
  - MODERATOR "microphone" vs microphone = moderator AND `live.speak` (every seeded moderating
    role holds it);
  - "locked community … if policy forbids" vs Q46, which forbids only Start;
  - "invalid session epoch" (clients never send one);
  - "token refresh" (there is no refresh route; `/join` re-authenticates);
  - UPPERCASE role names vs the lowercase wire vocabulary;
  - "live.raiseHand" vs `live.raise_hand`;
  - "don't remove TURN readiness checks": TURN has only static checks, which stay.
- **Fundamental:** none, beyond the policy decision in §2.

## 7. The 26-item real-media matrix

"C" means proven against the real server; "C (perm.)" means only the server-held permission is
asserted. The last column is what P7.2 adds, in new files (§8).

| # | Item | Real server today | Other proof | P7.2 adds |
| --- | --- | --- | --- | --- |
| 1 | Moderator starts a session | C: `application.spec.ts:77`, `readiness.spec.ts:93` | A | — |
| 2 | Member joins as listener | C: `publishing.spec.ts:88` | A | — |
| 3 | Listener gets a real token | C: `publishing.spec.ts:88`, `rooms.spec.ts:90` | A, B | — |
| 4 | Listener connects | C: `publishing.spec.ts:88` | — | receiving a speaker's audio |
| 5 | Listener cannot publish microphone | C: `publishing.spec.ts:113` | A, B | — |
| 6 | Listener cannot publish screen | C (perm.) | A, B | a refused screen publish |
| 7 | Listener cannot publish data | C (perm.) | A, B | refused data, text and metadata, with a positive control |
| 8 | Speaker grant works | C: grant, then `/join` | A | a grant pushed to a connected listener, who publishes without reconnecting |
| 9 | Speaker publishes microphone | C: `publishing.spec.ts:120` | A, B | — |
| 10 | Revoke works | C: `publishing.spec.ts:213` | A | — |
| 11 | Revoked speaker cannot continue | C in part (the live track) | A | same-connection republish refused; old-ticket rejoin corrected, then reset; the `#` chain ended (R1) |
| 12 | Moderator publishes microphone | C: `publishing.spec.ts:138` | A | — |
| 13 | Presenter flow | C: `publishing.spec.ts:176` | A | stop, revoke, and loss of `live.speak` closing the slot |
| 14 | Student cannot present | C (screen refused) | A | the claim refused and nothing pushed |
| 15 | Ended session rejects token | C: `rooms.spec.ts:138` | A | the connected client disconnected |
| 16 | Removed member rejected | — | A | `/join` refused; a connected member removed |
| 17 | Locked community follows policy | — | A | Q46 on the real server: join continues, Start refused |
| 18 | Reconnect keeps application authorization | — | A | the granted speaker rejoins speaking; the revoked one rejoins listening |
| 19 | Expired token needs re-auth | C: `rooms.spec.ts:161` | B | the refreshed token's lifetime and grants |
| 20 | Invalid room/session mapping fails closed | C in part (unknown room) | A | an old-epoch ticket after a reset; another deployment's prefix untouched |
| 21 | Wrong community fails | — | A | another community's member refused |
| 22 | Wrong identity fails | C: foreign identities (`identities.spec.ts`) | A, B | `DUPLICATE_IDENTITY` eviction |
| 23 | Concurrent grant/revoke deterministic | — | A (state only) | the server-held permission equals the final state after concurrent moderation |
| 24 | Ending reconciles media | C in part (the room deleted) | A | idle end; End whose `endRoom` failed, finished by the sweep |
| 25 | A room disappearing creates no state | — | A | a room deleted behind the application: re-ensured, no session created |
| 26 | Server unavailable fails safely | B only (stub, closed port) | A | the real server stopped mid-session and restarted without its rooms |

Corrections the verifier made:
- `readiness.spec.ts:161, :177` and `answers.spec.ts:135` run the real adapter against a stub,
  so they are B.
- `live-reconciler-watch.spec.ts` is a pure unit test (A).
- The rejoin at `publishing.spec.ts:190-193` asserts nothing, so it gives no evidence for item 18.

## 8. Tests and tooling

- **Harness gaps for the new C tests:**
  - `MediaClient` has no data publish or receive, subscription, or disconnect-reason hook.
  - `ServerView.refused()` matches any earlier log line, so a repeated check can false-pass. It
    must be scoped to lines after a mark.
  - Nothing can stop and restart a server on the same port and key (item 26).
  - The real suite runs on the in-memory store only.
- **Files over 1,000 lines** (brief §18) are existing test files: `live-contract-suite.ts` 1,550,
  `live-reconciler-participants.spec.ts` 1,329, `live.api.spec.ts` 1,295, `live-postgres.spec.ts`
  1,239 and `live-races.spec.ts` 1,103. None grows in P7.2; new specs go in new files. The only
  source file over 700 lines is `drizzle-live-repositories.ts` (769), which is cohesive and
  unchanged.
- **Scripts.** `test:arch` and `test:integration` pass `--testPathPatterns`, a Jest 30 flag, and
  Jest 29.7.0 ignores it, so both run the whole suite. The fix is Jest 29's `--testPathPattern`.
- **Architecture.** No rule stops `live/application` from importing `jose`, `jsonwebtoken` or
  `@nestjs/jwt` (brief §2). Add one.
- **SDK version.** `livekit-server-sdk` is `^2.9.0` (lockfile 2.19.1) and no test checks it. Pin
  it exactly, as `@livekit/rtc-node` already is.
- **Skips.** Without `TEST_DATABASE_URL`, 21 suites skip locally. Validation runs with Postgres.
- **Docker.** Docker 29.3.1 and Compose v5.1.1 are installed but not running. A local run of
  `infra/compose.yaml` with the pinned image by digest is possible. It would be local
  verification only, never a production claim.

## 9. What must not change

- the P6 domain rules and decisions;
- the approved no-enumeration 404, unless Q-A says otherwise;
- the provider boundary;
- the pinned v1.13.7, image digest and release sha256;
- P7.1's configuration gates and readiness self-check;
- the deployment files;
- the 300 + 10 limit;
- the identity = account id rule;
- the idle end (Q61);
- the Flutter app, which has no live data layer and needs none for P7.2 (brief §22).

## 10. Files involved

- **Source:**
  - `live/application/`: `join-live-session.use-case.ts`, `live-media.ts`,
    `live-reconciler-foreign.ts`, `live-reconciler-enforcement.ts`,
    `live-reconciler-participants.ts`, `live-reconciler-watch.ts`, `protect-live-sessions.ts`,
    `live-settings.ts`, `views.ts`;
  - `live/api/responses.ts`;
  - `live/domain/live-limits.ts` and `rtc-provider.ts`;
  - `live/infrastructure/`: `livekit-rtc-provider.ts`, `livekit-transport.ts`,
    `fake-rtc-provider.ts`;
  - `platform/config/app-config.ts` and `livekit-config.ts`.
- **Tests:**
  - new files under `backend/test/livekit/`, and support in `media-client.ts`, `server-view.ts`
    and `test-servers.ts`;
  - new unit specs beside the files above;
  - `test/architecture/live-boundaries.spec.ts` and `.dependency-cruiser.cjs`.
- **Docs:** `docs/p7-livekit-media-integration.md` (new), live.md, open-questions.md (Q47, Q63,
  Q64).

## 11. The plan once the decisions are in

The commits follow brief §27:
1. This audit.
2. Provider faults and the configurable token TTL.
3. The authorization and media-role fixes of §4.2–§4.7, with the ticket fields.
4. R1 (or the chosen option) and the readiness gate in the reconciler.
5. The new real-server tests of §7, and harness support.
6. Observability and hardening.
7. The documentation.

Each commit gets its own tests and the gates. The full validation runs at the end:
- verify with Postgres;
- the real suite, repeated;
- build and schema drift;
- compose validation;
- a local Docker run of the pinned image;
- GitHub CI.

---

**P7.2 STOPPED at the audit.** The integration exists and passes on the pinned server. But on
that same server a withdrawn publisher can keep publishing through self-renewing `#` identities
(§2, reproduced). Closing that needs your decision on §2.4. Q-A to Q-D (§3) settle the rest of
the plan. Nothing was implemented.
