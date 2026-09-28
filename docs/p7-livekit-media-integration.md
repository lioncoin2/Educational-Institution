# P7.2 — Real LiveKit media integration

**Date:** 2026-09-28. **Repository state:** `014f6b1` (code), this document on top.
**Scope:** P7.2 as the user approved it on 2026-09-28, after the
[audit](p7-livekit-media-integration-audit.md) (kept unchanged as the record). No Flutter file
(`app/`), no production deployment file, no P6 community or session rule, no presenter rule and
no limit changed. The LiveKit pin (v1.13.7) is unchanged. Nothing here claims production media
readiness or any capacity.

**The verdict is at the end: P7.2 STATUS: BLOCKED**, on one item of the approval (§10).

---

## 0. How to read it

- **Status words.**
  - **IMPLEMENTED:** in the code, with its tests in the main suite (`npm run verify`).
  - **VERIFIED LOCALLY:** observed against the pinned LiveKit server on this machine, by the
    committed real suite (`npm run test:livekit`), on the release binary and on the pinned
    image through Docker (§8).
  - **CI VERIFIED:** shown by a named GitHub Actions run.
  - **PRODUCTION VERIFIED:** observed on the deployed server. Nothing is.
  - **NOT YET VERIFIED:** none of the above.
- **Test categories** are the audit's: **A** unit and application over the fake or disabled
  provider; **B** the real adapter and SDK against mocks or a stub; **C** the real local LiveKit
  server with a real WebRTC client (`@livekit/rtc-node` 1.1.0); **D** production.
- **SRV** is LiveKit server v1.13.7 (`8d11efd`). `live/…` means `backend/src/modules/live/…`.
- The architecture is unchanged: Identity → Communities → Live → the provider port
  (`live/domain/rtc-provider.ts`) → the LiveKit adapter (`live/infrastructure/livekit-*.ts`) →
  LiveKit. Only the adapter imports the SDK; nothing in `live/` imports a JWT library (§7).

## 1. Decisions

The user's answers to the audit (2026-09-28):

| # | Decision | § |
| --- | --- | --- |
| R1 | A participant `<account>#<anything>` is evaluated against its base account. Its account, no longer authorized for what it held, is detected; the first sighting follows the removal path; a second sighting or reappearance triggers the approved media reset, which ends the self-renewing chain. Accounts still authorized are not affected; no reset on every revoke; no client-controlled identity semantics | 3 |
| Q-A | Non-member, other community and removed member stay one 404 on the wire. The reason goes to logs only | 4, 5 |
| Q-B | 503 `live.media_unavailable` for an unreachable, timed-out or unavailable provider; 503 `live.media_misconfigured` for refused credentials, TLS failure, a wrong endpoint. No secret, internal URL, stack or credential ever reaches a client | 4 |
| Q-C | `LIVE_JOIN_TOKEN_TTL_SECONDS`: default 120, 1–600, checked at boot, never hardcoded in the business logic | 4 |
| Q-D | Enforcement window 720 s | 3 |
| 6 | The reproduced exploit becomes a committed real-server regression test | 10 |
| 7 | The rest of the real-server matrix, each test proving real behaviour | 6 |
| 8 | A local Docker run of the pinned image and the real matrix against it, recorded | 8 |
| 9 | The architecture preserved; a rule keeps JWT libraries and SDK details out of Live | 7 |
| 12 | P7.2 stays BLOCKED until the security issue is fixed and regression-tested | end |

## 2. What changed, by commit

| Commit | What |
| --- | --- |
| `0aa7c9c` | The audit, STOPPED on the `#` chain |
| `b3413a0` | Typed provider faults (Q-B) and the configurable join-token lifetime (Q-C) |
| `d001f7c` | Pushes serialized per person; `/join` asks Communities again before signing; the directory call fails closed; ticket `sessionId` and `expiresAt`; internal `LIVEKIT_URL` hosts refused when deployed |
| `101b0e5` | R1, the 720 s window and the narrowed readiness gate, hardened after an adversarial review (§3) |
| `84f7e08` | Structured log lines (§5); the JWT architecture rule; `livekit-server-sdk` pinned to 2.19.1; the `test:arch` and `test:integration` scripts fixed (they used Jest 30's flag, so ran everything) |
| `014f6b1` | Six new real-server files for the matrix (§6), their harness, and the Docker runtime (§8) |

## 3. R1: the `#` identities

**The mechanism** (audit §2, from SRV and reproduced there): any publish-capable token presented
with `publish=<x>` joins as a second standard participant `<account>#<x>`, and the server hands
every connection a fresh token of its own, valid ten minutes. Removal alone never ended the
chain, because each link brought the next token.

**The rule as built** (`live/application/live-reconciler-foreign.ts`,
`-enforcement.ts`, `-participants.ts`, `-watch.ts`):

- **Removal on the identity alone.** Every standard participant the application never issued is
  removed at once, before and whatever Communities says, and watched for 720 s.
- **Its account decides what it counts for.** The id before `#` is read with the people: never
  the identity, whose rest the client chose. An account that Communities no longer lets stay, or
  whose standing no longer allows what the identity held, has breached (`breachedThrough`). An
  account still entitled to everything its identity held has not: the identity is removed and
  nothing more, so a legitimate speaker is never counted, demoted or reset because of it.
- **First sighting, then reappearance.** A breaching sighting arms the account for 720 s. Its
  next breaching sighting inside the window, under any suffix, is a violation: counted on the
  session, logged, and the approved media reset moves the session to a new room (epoch + 1).
- **Why the reset ends it.** Every token the server ever refreshed for such an identity names
  the old room, which is deleted and never comes back (`auto_create: false`). `/join` gives the
  account only what it may hold now: a listener's token, which the server refuses with `publish`
  (401), so it can make no second identity at all.
- **The window, 720 s** (Q-D): the server's 600 s refreshed token, its 60 s expiry leeway and one
  60 s participant sweep (`ENFORCEMENT_WATCH_SECONDS`, pinned by a test to that sum).

**What counts as a repeat.** An adversarial review of the first version (three reviewers) raised
eight findings: ways it could be defeated, rooms it could reset wrongly, a gate that could
switch enforcement off, and two tests that passed by coincidence. All were fixed before the
commit, each with a regression test; independent verifiers then re-checked six of them against
the fixed code and found each resolved. The four that shaped the rule:

| Finding | Fix | Test |
| --- | --- | --- |
| Any act that stepped the session's version (a hand raised, granted or revoked by anyone) held off the violation, so a moderator could keep the chain alive by churning other hands | A violation is held off only by what raced the observation for **that person**: the session ended or moved, or they lost the floor or the presenter slot during the step (`Observation.raced`) | `live-reconciler-foreign-breach.spec.ts`, `live-reconciler-sightings.spec.ts` ("never lets anyone else's act hold off …") |
| The account's own identity and its `#` identities shared one arm, so which step saw which first decided a reset, and an app back on its last refreshed token after missing a revoke could reset the room | Two arms that never mix (`ReconcilerWatch.armed`, `.foreignArmed`) | `live-reconciler-sightings.spec.ts`, `live-reconciler-watch.spec.ts` |
| The watch listed the room only while a foreign identity was watched, so an account under enforcement for its own identity was found under a suffix only by the 60 s sweep | The watch lists the room whenever anything is watched in the session, and checks the account behind each foreign identity in the same step | "finds the account under a suffix at the watch …" |
| A failed removal lost the step's sightings, so an identity whose removal always fails shielded its account | Every identity seen is a sighting, whatever its removal came to; the failure still skips the step afterwards | `live-reconciler-identities.spec.ts` ("tries every removal …") |

Each fix was also checked by mutation: restoring the old behaviour makes its tests fail (session
version guard: 2 tests; shared arm: 3; foreign-only listing: 2; a failed removal losing its
sightings: 3; the wider gate below: 2).

**The readiness gate.** The participant sweep, the watch and `ProtectLiveSessions`' checks stop
only while the self-check says `incompatible_response`: something on the URL answers but is not
LiveKit, and its answers would pass for LiveKit's (the room sweep already stopped there). Every
other failure is the calls' own to report, typed (Q-B). A first version also stopped on
`unauthorized` and `tls_failure`, which let a self-check failing where the calls did not (its
30 s token against a skewed clock) switch enforcement off, and made the logs flap. Fixed and
tested ("still enforces while the self-check says …").

**What remains** (bounded, and recorded rather than hidden):

- **Until the reset.** The first link publishes until it is removed (at most one participant
  sweep, 60 s, for an account nothing watched yet), the second until the next watch tick (10 s).
  The reset then disconnects everyone briefly; everyone else rejoins through `/join` with what
  they held. This is the approved protection.
- **Observation is periodic.** The reconciler polls (sweep 60 s, watch 10 s). A client connected
  only between observations is not seen, so with careful timing a withdrawn publisher could
  publish in bursts without a second sighting. Closing that needs event-driven observation
  (LiveKit webhooks) or stripping `publish` at the TLS terminator (the audit's R3); both are
  deployment work, outside P7.2.
- **The gate's trade-off.** While the self-check says `incompatible_response`, enforcement
  pauses. That state is an operator-visible error (logged once, and Start refuses with 503
  `live.media_misconfigured`), not something a client can cause.
- **Self-granted floors.** An account that is both a session moderator and allowed to raise a
  hand can grant its own floor and yield it during a step, which exempts that one step. Its raise
  limit (6 a minute) bounds it below the watch's and sweep's rate together.
- **Not proven against the real server** (§10).

## 4. The wire and the configuration

- **`/join` refusals (Q-A).** Unknown session, non-member, another community's member and a
  removed member get identical answers, `404 live.session_not_found` (tested in the application
  and on the real server). The reason is only in `live.join.denied` (§5).
- **Provider failures (Q-B).** An outage (`unreachable`, `timeout`, `server_error`, `disabled`)
  answers 503 `live.media_unavailable`; a refused configuration (`unauthorized`, `tls_failure`,
  `incompatible_response`) answers 503 `live.media_misconfigured`. Start maps its readiness
  reasons the same way (`unreachable` and a disabled provider are an outage; everything else a
  misconfiguration). The reason stays in logs; no URL, key, message or stack reaches a client.
  `/join` still signs during an outage (signing needs no server) and fails closed on a
  misconfiguration.
- **Join-token lifetime (Q-C).** `LIVE_JOIN_TOKEN_TTL_SECONDS`, default 120, whole seconds from
  1 to 600, else boot is refused; passed through compose, documented in `backend/README.md` and
  `.env.example`, and checked again where the token is minted. It bounds only the first
  connection: the server refreshes a connected client's token itself.
- **The ticket** gains `sessionId` and an ISO `expiresAt`, never later than the token's own
  expiry. Additive.
- **`/join` decides again before signing** (D20, as Start does): a removal, revoke, end or reset
  committed during its provider round trips is honoured. The account directory call fails closed.
- **Pushes are serialized per person**, each reading the standing only once the previous one
  landed, and a push to someone Communities no longer lets stay carries no standing's set.
- **Deployed `LIVEKIT_URL`** may not name an internal host (loopback, single-label, RFC 1918):
  every ticket hands it to clients.

## 5. Observability

Structured lines through Nest's logger; ids, codes, counts and outcomes only. Never a token, a
secret, a name, an `Authorization` header, or anything a client chose (every real-suite file and
`live-observability.spec.ts` assert it).

| Line | Fields |
| --- | --- |
| `live.join.admitted` | session, user, role |
| `live.join.denied` | session (when the id is well formed), user, internal reason, wire code; Communities' own refusal code where it refused |
| `live.token.issued` | session, user, role, epoch, TTL, `expiresAt`, what it may publish |
| `live.media.authorization_changed` | session, user, cause (a stored change or a reconciler correction), outcome, microphone, screen |
| `live.speaker.granted` / `.revoked` | session, request, user, by, push outcome |
| `live.presenter.claimed` / `.closed` | session, grant, user, (by, `stopped` or `revoked`), push outcome |
| `live.reconciler.tick` | tick, its report's counts, duration; logged when it changed something, at debug otherwise |
| `live.reconciler.foreign_breach`, `.violation` (`via: foreign_identity`), `live.session.media_reset` | R1's decisions |

## 6. The 26-item matrix

C is on the real server; "local" is VERIFIED LOCALLY on the binary and on Docker (§8); "CI" is
CI VERIFIED (run #59 for P7.2's files, earlier runs for P7.1's).

| # | Item | Proof | Status |
| --- | --- | --- | --- |
| 1–3 | Start; a member joins as a listener; a real token | `application.spec.ts`, `publishing.spec.ts`, `rooms.spec.ts` (P7.1) | C, local, CI |
| 4 | A listener connects **and hears a speaker** | `listeners.spec.ts`: the listener receives the speaker's 440 Hz tone through the server | C, local, CI |
| 5 | A listener cannot publish the microphone | `publishing.spec.ts` (P7.1) | C, local, CI |
| 6 | A listener cannot publish a screen | `listeners.spec.ts`: the server refuses it (NOT_ALLOWED) and nobody receives one | C, local, CI |
| 7 | A listener cannot publish data | `listeners.spec.ts`: its data and text are dropped by the server while a control whose token differs only in `canPublishData` reaches everyone; its own metadata and name changes are refused | C, local, CI |
| 8 | A grant works | `floor.spec.ts`: pushed to the connected listener, whose same connection then publishes | C, local, CI |
| 9–10 | A speaker publishes; revoke works | `publishing.spec.ts` (P7.1) | C, local, CI |
| 11 | A revoked speaker cannot continue | `floor.spec.ts`: the same connection is refused the microphone again. The `#` chain: unit and application tests only (§3, §10) | C **in part**; local, CI |
| 12 | A moderator publishes the microphone | `publishing.spec.ts` (P7.1) | C, local, CI |
| 13 | Presenter flow | `presenters.spec.ts`: stop, a moderator taking the slot back, and the loss of `live.speak` (at the sweep) each close it; the server takes the screen | C, local, CI |
| 14 | A student cannot present | `presenters.spec.ts`: a student on the floor and a member who moderates nothing are refused, nothing pushed, their screens refused | C, local, CI |
| 15 | An ended session rejects tokens | `lifecycle.spec.ts`: End disconnects everyone (`ROOM_DELETED`); `rooms.spec.ts` (P7.1) | C, local, CI |
| 16 | A removed member is rejected | `membership.spec.ts`: removed from the room by the server the moment the fact reaches `ProtectLiveSessions` (`PARTICIPANT_REMOVED`), then the same 404 as anyone | C, local, CI |
| 17 | A locked community follows policy | `membership.spec.ts` (Q46): nobody removed, a member joins, raises a hand and speaks; no new session and no room | C, local, CI |
| 18 | Reconnect keeps authorization | `floor.spec.ts`: the granted speaker rejoins speaking, the revoked one listening | C, local, CI |
| 19 | An expired token needs re-auth | `rooms.spec.ts` (P7.1): refused past the lifetime and leeway | C in part, as before |
| 20 | Invalid room/session mapping fails closed | `lifecycle.spec.ts`: after a reset the old room is gone with everyone in it and its ticket refused (404); another deployment's room is never touched | C, local, CI |
| 21 | Wrong community fails | `membership.spec.ts`: refused as an outsider is; their own ticket admits them to their own room only | C, local, CI |
| 22 | Wrong identity fails | `lifecycle.spec.ts`: a second connection of the account evicts the first (`DUPLICATE_IDENTITY`); `identities.spec.ts` (P7.1) | C, local, CI |
| 23 | Concurrent grant/revoke is deterministic | `floor.spec.ts`: five rounds of grants, revokes and yields landing together in different orders; after each, the server holds exactly what is stored, then and 500 ms later (both outcomes occurred in the runs recorded) | C, local, CI |
| 24 | Ending reconciles media | `lifecycle.spec.ts`: an idle end deletes the room; an End whose room deletion failed is finished by the room sweep | C, local, CI |
| 25 | A room disappearing creates no state | `lifecycle.spec.ts`: a room deleted behind the application is made again; no session, audit or event | C, local, CI |
| 26 | Server unavailable fails safely | `outage.spec.ts`: a server of the file's own is killed mid-session: Start 503, every tick skipped, nothing ended; restarted empty, the sweep makes the room again and a ticket from the outage admits its holder as what they are | C, local, CI |

Where a test needed a state no client could reach honestly, it says how it made it: item 20's
reset is driven by a permission the server's own room API set back (as a provider that lost a
correction would hold it); item 24's failed deletion is one injected adapter failure; item 26
kills and restarts the server process or container.

## 7. Tests

| Category | P7.2's files | Ran |
| --- | --- | --- |
| A | `live-reconciler-foreign-breach.spec.ts`, `-sightings.spec.ts`, `live-observability.spec.ts` (new); updated join, media, reconciler, watch, identities, participants, readiness and configuration specs; the API specs' ticket shape | `npm run verify` |
| B | `livekit-rtc-provider(-failures).spec.ts`, `livekit-transport.spec.ts`, `livekit-readiness.spec.ts`, `livekit-redaction.spec.ts` (typed faults) | `npm run verify` |
| C | `test/livekit/`: `listeners`, `floor`, `presenters`, `membership`, `lifecycle`, `outage` (new), and P7.1's six: **12 files, 65 tests** (P7.1: 6 and 36) | `npm run test:livekit`, both runtimes |
| Architecture | `live-signs-and-reads-no-jwt` (dependency-cruiser) with its positive and negative samples in `rules-match.spec.ts`; the SDK pin in `livekit-suite.spec.ts` | `npm run verify` |

**What ran for this document, on `014f6b1`:** the main suite with Postgres,
**189 suites and 2,761 tests, all passed, 0 skipped**, with format, lint,
typecheck and the dependency graph (390 modules, 2,010 dependencies, no
violation); `npm run build`; `drizzle-kit generate` with no schema change; the real suite three
times on the binary (65 of 65 each, 19–24 s) and once on Docker (65 of 65); `docker compose
config` for the committed files.

**File sizes.** No source file P7.2 touched exceeds 500 lines (the largest:
`live-reconciler.ts` 498, `live-reconciler-participants.ts` 482). Four specs sit between 500 and
700 (`live-reconciler.spec.ts` 619, `-foreign-breach.spec.ts` 566, `join-live-session.spec.ts`
562, `-identities.spec.ts` 508): each is one subject. Two specs already over 1,000 lines grew
only where existing assertions changed: `live.api.spec.ts` (1,295 → 1,315, the ticket shape)
and `live-reconciler-participants.spec.ts` (1,329 → 1,338); no test was added to either.

## 8. Local Docker verification

On this machine: Docker 29.3.1, the committed `infra/compose.yaml`, the pinned image
`livekit/livekit-server:v1.13.7@sha256:6fd3b708…2a3`. Docker Hub refused unauthenticated pulls
(rate limit), so the image was pulled **by digest** from `mirror.gcr.io` (Google's Docker Hub
mirror) and tagged locally; the digest is the committed one. Nothing ran on the VPS.

- **The committed service, run and inspected** (a throwaway environment file, 0600, with
  generated secrets and `LIVEKIT_NODE_IP=127.0.0.1`): `compose config` valid; healthy by its own
  health check; the image by tag and digest, its id the pinned digest; every capability dropped;
  `no-new-privileges`; the policy file mounted read-only; only `LIVEKIT_KEYS` and `NODE_IP`
  passed in; signalling on 127.0.0.1:7880 only, ICE on 7881/tcp and 7882/udp; `GET /` "OK"; the
  start line version 1.13.7; JSON logs at info. Then taken down: no container, network or volume
  left.
- **The real matrix against it:** `LIVEKIT_TEST_RUNTIME=docker npm run test:livekit` starts the
  policy server as `docker compose -f infra/compose.yaml up livekit` in a project of its own
  (`--pull never`), the `auto_create` server as a `docker run` of the same image with the same
  hardening, and item 26's restartable server as its own container. **12 files, 65 tests, all
  passed.** Teardown left nothing running.

This is local verification only: loopback, one machine, no TLS, no TURN, no NAT.

## 9. Status

| | |
| --- | --- |
| **IMPLEMENTED** | R1 with the 720 s window, the per-person race rule, separate arms, listing under enforcement, sightings that survive failures, the narrowed gate; Q-A, Q-B, Q-C; `/join` re-decided before signing; serialized pushes; ticket fields; the internal-host refusal; the log lines; the JWT rule; the pins and scripts |
| **VERIFIED LOCALLY** | Matrix items 1–10 and 12–26, and 11 in part, on the release binary and on the pinned image (§6, §8), item 19 as before; the committed compose service's configuration |
| **CI VERIFIED** | CI #56 (`d001f7c`), #57 (`101b0e5`), #58 (`84f7e08`): backend verify with Postgres, build, deployment files, and the real suite, all succeeded. #59 (`014f6b1`) the same, with the real suite at **12 files and 65 tests**, all passed on GitHub's runner (the release binary) |
| **PRODUCTION VERIFIED** | Nothing |
| **NOT YET VERIFIED** | The `#` chain ended on the real server (§10); the refreshed token's lifetime; a join above `maxParticipants`; external clients, NAT and TURN; everything in §11 |

## 10. Not done

- **Decision 6 — the real-server exploit regression.** Not written in P7.2. R1 is proven by the
  unit and application suites against the fake provider, which model the server's behaviour as
  the audit found it, but no committed test drives the reproduced chain against the pinned
  server and shows it ended. By decision 12, P7.2 stays BLOCKED on this.
- **Item 11's rejoin half** on the real server (a revoked speaker's old ticket corrected, then
  reset): covered in unit tests; the real suite shows the same-connection half and a reset.
- **Item 19's addition** (the refreshed token's lifetime and grants): not added.

## 11. Production verification still pending

The VPS; TLS (terminator, hostnames, certificates); public networking; TURN and NAT (P7.1.1's
TURN decision is still the owner's); external clients; the production firewall; production DNS;
P8 capacity testing. The 300 + 10 limit is unchanged, and nothing here supports a claim of
3,000 users per room or 10,000 concurrent users.

---

**P7.2 STATUS: BLOCKED.** The security fix is implemented, reviewed adversarially, and tested
in the main suite; the remaining matrix is proven on the pinned server, locally on the binary
and on Docker. The committed real-server regression of the reproduced exploit (decision 6) does
not exist, so decision 12's condition is not met. Production media readiness is not claimed.
