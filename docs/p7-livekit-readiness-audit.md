# P7.1 — LiveKit server configuration and provider readiness: audit

**Date:** 2026-09-27. **Repository state:** `ef028be` (P6 and its decisions, accepted).
**Scope:** the read-only Phase 0 of P7.1. Nothing outside this document was changed.

**Verdict at the end: P7.1 READINESS: BLOCKED** — on four infrastructure decisions (TURN,
network topology, TLS, environment separation) that the repository leaves open under
[Q65](architecture/open-questions.md#q65--media-hosting-and-operations) and that the brief forbids
inventing. Everything on the LiveKit side is verified and clear; §8 lists the exact decisions
that unblock P7.1, and §9 the implementation that follows once they exist.

---

## 0. Method and sources

- **Official LiveKit sources only.** `docs.livekit.io` is not reachable from this environment (the
  egress proxy answers 403). The official sources that are reachable were used instead:
  - the **server release v1.13.7** (`livekit_1.13.7_linux_amd64.tar.gz`, sha256
    `6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2`, matching the release's
    `checksums.txt`; `livekit-server --version` → `1.13.7`);
  - the **server source at tag v1.13.7** (`github.com/livekit/livekit`): `config-sample.yaml`,
    `pkg/config/`, `pkg/service/`, `pkg/rtc/` — cited below as **SRV**;
  - `github.com/livekit/protocol` at the revision the server pins (`go.mod`), cited as **PGO**;
  - the installed **`livekit-server-sdk` 2.19.1** (`backend/node_modules/`), cited as **SDK**; and
    **`@livekit/rtc-node` 1.1.0**, LiveKit's Node client, used only in throwaway probes.
- **VERIFIED** means read in that source or observed by running the v1.13.7 binary locally
  (127.0.0.1, `room.auto_create: false`, keys through `LIVEKIT_KEYS`, a random secret never
  printed). **ASSUMED** is marked where it applies. The probes were throwaway scripts outside the
  repository; none is committed.

---

## 1. Current provider architecture (as built in P6)

| Item | Where | Status |
| --- | --- | --- |
| Vendor-free port, split into rooms / tokens / participant control / observer | `live/domain/rtc-provider.ts` | VERIFIED |
| Total capability sets; explicit source list; no camera in the vocabulary | `rtc-provider.ts`, `domain/standing.ts` | VERIFIED |
| Screen only for a presenter holding `live.speak` (P6 decision 1); never screen audio | `standing.ts` `capabilitiesFor` | VERIFIED |
| One outage type, `RtcUnavailableError` | `rtc-provider.ts` | VERIFIED |
| Binding (D19): development secret → fake; `LIVE_MEDIA_PROVIDER=livekit` → LiveKit adapter; anything else → disabled provider (every call refuses; Start 503, nothing stored) | `live/live.module.ts` `rtcProviderFor` | VERIFIED |
| Boot refusals under `livekit`: room prefix required; key not a placeholder; secret not a placeholder and ≥ 32 bytes | `platform/config/app-config.ts` | VERIFIED |
| The SDK is imported by exactly one source file | `live/infrastructure/livekit-rtc-provider.ts` (370 lines); dependency-cruiser rule; `test/architecture/live-boundaries.spec.ts` | VERIFIED |

The domain and application layers know no LiveKit type. The adapter file is within the brief's
size rule (300–500, cohesive).

## 2. Current LiveKit integration, checked against the server

**Version.** Server **v1.13.7** (pinned by the design: `live.md` §0, ADR 0019) and SDK
**2.19.1** (`package-lock.json`; CI uses `npm ci`). The SDK's `@livekit/protocol` 1.51.0 matches
the protocol revision the server pins. VERIFIED.

**Token (the security boundary).** The adapter signs HS256 with `iss` = API key, `sub` = the
account id, `name` = the directory's display name, `exp` = now + 120 s (SDK `AccessToken.ts`), and
a `VideoGrant` with: `room` = the server-derived room name, `roomJoin`, `canPublish` exactly when
the source list is non-empty, an **explicit** `canPublishSources`, `canSubscribe`,
`canPublishData: false`, `canUpdateOwnMetadata: false`, `hidden: false`, and no
`roomCreate`/`roomAdmin`/`roomList`/`roomRecord`/`agent` grant. The server binds the join to the
token's `room` (SRV `pkg/service/auth.go`, `utils.go`), treats an empty source list as *all*
sources (PGO `grants.go` — hence the adapter's explicit list), and blocks client metadata and name
changes without `canUpdateOwnMetadata` (SRV `utils.go`, `pkg/rtc/participant.go`). VERIFIED in
source and by a real round trip: a listener token appears server-side as `canPublish: false,
sources: [], data: false`; a speaker's as `sources: [MICROPHONE]`; identity and name as issued.

No client input reaches a token: `/join` takes only the session id from the path; the room name is
`mediaRoomName(prefix, sessionId, epoch)`; the identity is the principal's user id; the name comes
from `ACCOUNT_DIRECTORY`; the capabilities from `capabilitiesFor(standing)`. The token builder
consumes facts already authorized by `LiveAccess`. VERIFIED.

**Real media behaviour (RUN, `@livekit/rtc-node` 1.1.0 against v1.13.7):**
- a listener token publishing a microphone track → refused (`no permission to publish track`);
- a speaker token → microphone published;
- a microphone-only speaker publishing a screen track → refused;
- demotion through the adapter's `updateCapabilities` → `applied`, and the server unpublishes the
  microphone;
- a valid token for a room that does not exist, under `auto_create: false` → refused.
A positive screen-share publish by a presenter was **not** run.

**Room service mapping (RUN).** `createRoom` with `maxParticipants`, `emptyTimeout`,
`departureTimeout`; `deleteRoom` (a second delete → 404 `not_found`, mapped to success);
`listRooms` filters by name; `listParticipants` of a missing room → `[]`; `getParticipant` of a
missing identity → 404 `not_found`. **Correction to `live.md` (§10.1/§11 wording "finds and
updates it"):** `createRoom` on a room that is live in memory returns it **unchanged**
(SRV `roommanager.go`); a second call with a different `maxParticipants` kept the first value.

**`auto_create`.** The server default is **true** (SRV `pkg/config/config.go`), so it must be
pinned. With `room.auto_create: false`, VERIFIED: a WebSocket join to a missing room is refused;
after `deleteRoom`, a still-valid token cannot bring the room back; `/rtc/validate` answers **404**
for a missing room with a `roomJoin`-only token, **200** for an existing room, **200 for a missing
room when the token carries `roomCreate`** (which the adapter never grants), **401** for a wrong
secret, an unknown key or no token. One probe therefore distinguishes: ready (404), `auto_create`
on (200), bad credentials (401), unreachable or wrong endpoint (transport error or a non-LiveKit
status). The server's own liveness is `GET /` → 200 "OK" or 406 "Not Ready" (SRV `server.go`).

**Errors (RUN).** Wrong secret / unknown key → `ServerError` 401 without a Twirp code →
`misconfigured` ✔; connection refused, DNS failure, timeout → `unavailable` ✔ (a DNS failure is
indistinguishable from an outage); a real "not found" → 404 with `code: "not_found"` ✔. The SDK
applies a 10 s request timeout by default and fails over only for `*.livekit.cloud` hosts.

**Token lifetime.** 120 s, checked at the call site (1–600, audit D24). The server verifies with
**60 s leeway** (PGO `verifier.go`), so a 120 s token is accepted until about 180 s after `nbf`; a
real-server expiry test must allow for it. A connected client is sent a fresh token every five
minutes, valid ten minutes, carrying its current permissions (SRV `roommanager.go`).

## 3. Configuration gaps

| # | Gap | Evidence |
| --- | --- | --- |
| C1 | No LiveKit server configuration exists anywhere in the repository (no `livekit.yaml`, Dockerfile, Compose, Caddyfile). ADR 0019: "The repository holds no LiveKit deployment configuration". | `find`; ADR 0019 |
| C2 | `auto_create=false` is designed but not pinned in any file, and the server default is `true`. | SRV `config.go` |
| C3 | One `LIVEKIT_URL` serves two roles: the client connect URL returned in the join ticket, and — rewritten `ws→http` — the server-to-server API endpoint. A topology where the API reaches LiveKit privately while clients use `wss://<domain>` cannot be expressed. Admin calls carry a 10-minute admin JWT on that URL, in clear text over `ws://`/`http://`. | `livekit-rtc-provider.ts`; SDK `ServiceBase.ts` |
| C4 | `LIVEKIT_URL` is not validated (parseable, `ws`/`wss`) and `ws://` is accepted in production; with `livekit` enabled outside production it silently defaults to `ws://localhost:7880`. | `app-config.ts` |
| C5 | Nothing refuses `LIVEKIT_API_SECRET` equal to `JWT_SECRET` or `STORAGE_SIGNING_SECRET` (the brief requires the separation; there is precedent for such a check). | `app-config.ts` |
| C6 | `NODE_ENV` is an unchecked cast: `staging` loads as non-production with placeholder secrets. | `app-config.ts` |
| C7 | The SDK's `requestTimeout` and `failover` are defaults, not stated. | `livekit-rtc-provider.ts` |
| C8 | `enable_remote_unmute` must be pinned false with the rest of the design's server config (ADR 0019 decision 7). Default verified false (SRV `config.go`). | SRV |

## 4. Network gaps (ports VERIFIED for v1.13.7; exposure depends on topology)

| Port | Proto | Purpose | Public/private | Required |
| --- | --- | --- | --- | --- |
| 7880 | TCP | HTTP: WebSocket signalling, the Twirp room API, `/rtc/validate`, `/` liveness. **Plain HTTP only** — the server never terminates TLS (SRV `server.go`); "should be placed behind a load balancer with TLS" (`config-sample.yaml`) | private; clients reach it only through a TLS terminator on 443 | required |
| 7881 | TCP | ICE over TCP (media fallback). Listens on all interfaces; must not be behind a load balancer or TLS | public | on by default; optional (`tcp_port: 0` disables it — not recommended) |
| 50000–60000 | UDP | ICE media, the default when neither `udp_port` nor a range is set (outside `--dev`) | public | required if the range is used |
| `udp_port` (e.g. 7882) | UDP | single-port UDP mux, instead of the range (a range takes precedence if both are set) | public | required if the mux is used |
| 3478 | UDP | embedded TURN/UDP; **default 0** (the sample's 3478 is not the default) | public | only with TURN |
| `turn.tls_port` | TCP | embedded TURN/TLS. **Always advertised to clients as `turns:<domain>:443`**, whatever `tls_port` is (SRV `roommanager.go`) — so something must answer TURN/TLS on public **443** | public on 443 | only with TURN |
| 30000–40000 | UDP | TURN relay range (host-local to the SFU on the same node — ASSUMED no public exposure needed) | private | only with TURN |
| 6789 | TCP | Prometheus metrics (the design pins `prometheus_port`) | private | optional |

Further VERIFIED facts that constrain the topology:
- Behind Docker bridge networking the auto-detected node IP is the container's. The options are
  host networking, or `node_ip` set to the public IP with the media ports published one-to-one.
- `use_external_ip: true` discovers the IP through STUN; with STUN unreachable the server blocked
  about 47 s at startup and then exited. So it must be `false` wherever outbound STUN is not
  guaranteed, with `node_ip` given explicitly.
- `--dev` / `development: true` uses the keys `devkey`/`secret` and puts pprof on the main port: it
  must never be used outside a developer's machine.

**Gap N1.** Which ports are public, which private, what terminates TLS on 443 for signalling, and
whether the single VPS also answers TURN/TLS on 443, are **not decided anywhere** (§8).

## 5. Security gaps

| # | Finding | Severity | Evidence |
| --- | --- | --- | --- |
| **S1** | **A bare 404 is classified `not_found`.** Pointing `LIVEKIT_URL` at a wrong or non-LiveKit endpoint that answers 404 makes `endRoom` "succeed", `getParticipant` return null, `listParticipants` return `[]` and updates return `not_connected` — silently. Only a 404 with the Twirp code `not_found` may count as not-found; a codeless 404 is misconfiguration. A correctness bug; unreachable today because the adapter is never bound without the opt-in. | medium (latent) | `livekit-rtc-provider.ts` `classify`; RUN against a non-LiveKit server |
| **S2** | **Client-chosen secondary identity.** A token with `canPublish: true` plus the URL parameter `?publish=<x>` joins as the STANDARD participant `<userId>#<x>` with the microphone (SRV `utils.go`). A listener token is refused (401), so the exposure is limited to speakers, moderators and presenters, whose rights it does not widen; but the suffix is client-chosen, and the reconciler judges `<uuid>#<x>` as an unknown account (ASSUMED: found ineligible and removed within a sweep). The brief's "arbitrary identity blocked" needs these identities recognized and removed explicitly, and a real-server test. | medium | RUN; SRV `utils.go` |
| S3 | Admin calls over a non-TLS URL across a network expose 10-minute admin JWTs (C3). | depends on topology | SDK `ServiceBase.ts` |
| S4 | JWT/storage/LiveKit secret separation not enforced (C5). | low | `app-config.ts` |
| S5 | The server logs the API **key** (not the secret) on a 401 (SRV `service/utils.go`). No secret or token was found in the server's logs during the probes; the adapter logs error class, status and code only. | informational | RUN |
| S6 | `mutePublishedTrack` for an identity that left answers 503 `unavailable` (not 404) and so becomes `RtcUnavailableError` rather than `not_connected`. No caller uses mute yet (Q64). | low | RUN; SRV `roomservice.go` |

TURN credentials are generated per participant by LiveKit (embedded TURN) or derived by LiveKit
from a shared secret (`turn_servers`); the application never holds them in either design (SRV
`roommanager.go`). VERIFIED.

## 6. Environment gaps

- **No staging environment is defined** anywhere in the repository; `NodeEnv` is
  `development | test | production`, unvalidated (C6). Nothing loads per-environment env files.
- **Per-environment LiveKit keys and servers are not defined.** The only separation is
  `LIVE_ROOM_NAME_PREFIX` ("unique to the deployment" on a shared server) and Q65's rule that load
  tests never use production keys or rooms.
- **Deployment topology.** The documents assume **one VPS** running the API, Postgres and LiveKit
  (hub §20.2; `live.md` §21; one API instance until P11) — but not *how*: Docker, systemd or a bare
  binary; which reverse proxy; which domain names; where TLS terminates; which interfaces are
  public; the firewall. Q65 is **open**: "Where does it run relative to the API on the VPS?", "Is
  TURN over TLS on port 443 needed for school and home networks?", self-hosted or LiveKit Cloud.
  Its provisional default — self-hosted open-source LiveKit, `auto_create=false`, no webhooks, no
  recording, **one node for development and load tests** — does not cover production TLS, TURN or
  staging, and says "A TURN decision is needed before the first real class."
- **TURN: the brief and the repository disagree.** The brief says the approved P7 readiness design
  *includes* TURN; ADR 0019 decision 7 and `live.md` §9 name only "a TURN placeholder (Q65)", and
  hub §20.2(3) leaves "embedded TURN over TLS on 443, or a dedicated server" to Q65.

## 7. Test gaps

| Category | Today | Gap |
| --- | --- | --- |
| 1 Fake provider | deterministic fake; used by every Live suite | none |
| 2 Adapter unit | `livekit-rtc-provider.spec.ts` (token grants per role, capability mapping, error classification, log redaction); the real adapter's signed JWT decoded per role in `live-security.api.spec.ts` | S1 (codeless 404), a falsy-TTL guard in the adapter itself (defence in depth: the SDK turns a falsy TTL into 6 h), explicit client options |
| 3 Real LiveKit integration | **none in the repository** (the design's "LiveKit adapter contract suite", `live.md` §21, is unbuilt); probes in this audit were throwaway | the whole suite, run in CI against the pinned v1.13.7 binary, never skipped |
| 4 Deployment readiness | none | the self-check (§9 step 4), config parsing for the real mode |

A real-server suite that skips when no server is present would break the "0 skipped" rule
locally; it must run only where the server is provided (CI) and be excluded, not skipped,
elsewhere — a convention to agree in P7.1.

## 8. Stop conditions (brief items 1–15)

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | LiveKit server version | **CLEAR** | v1.13.7, checksum-verified; SDK 2.19.1 aligned |
| 2 | API key/secret handling | **CLEAR** (mechanics) | env `LIVEKIT_KEYS` or a `key_file` the server refuses unless it is not other-readable; app refuses placeholders and short secrets; separation check to add (C5) |
| 3 | RTC endpoint | **UNCLEAR** | the client URL is clear in form (`wss://<host>`); the host, and whether the API uses a private endpoint (C3), depend on #12/#13 |
| 4 | WebSocket/RTC transport | **CLEAR** | WS signalling on 7880 behind TLS; ICE UDP (range or mux) plus ICE/TCP 7881 |
| 5 | UDP/TCP ports | **CLEAR** (list) / exposure depends on #12 | §4 |
| 6 | TURN requirements | **UNCLEAR — BLOCKING** | Q65 open; embedded vs dedicated undecided; TURN/TLS must answer on public 443, which on one VPS collides with HTTPS unless an SNI/L4 split or a second IP is chosen; needs a domain and a certificate; the brief and the repository disagree (§6) |
| 7 | Token signing | **CLEAR** | HS256, key/secret, 120 s, verified end to end |
| 8 | Room creation policy | **CLEAR** | only the application creates rooms (Start, join's ensure-then-recheck, the reconciler); the adapter never grants `roomCreate` |
| 9 | auto-create | **CLEAR** | default true; `room.auto_create: false` enforced and verified; detectable by `/rtc/validate` |
| 10 | Server authentication | **CLEAR** | API calls signed per call; 401 on wrong key/secret verified |
| 11 | Health/readiness | **CLEAR** (mechanics) | LiveKit `GET /`; `/rtc/validate` as the self-check; see §9 step 4 for exposure |
| 12 | Docker/network topology | **UNCLEAR — BLOCKING** | no infrastructure in the repository; Q65 "where does it run relative to the API" open; Docker bridge vs host networking and `node_ip` depend on it |
| 13 | TLS requirements | **UNCLEAR — BLOCKING** | LiveKit terminates no TLS, so a terminator is required for `wss://`; no domain, certificate source or terminator (Caddy, nginx, a load balancer) is decided; `ws://` accepted in production today |
| 14 | Provider-to-server connectivity | **CLEAR** (behaviour) / **UNCLEAR** (route) | timeouts and error shapes verified; public hairpin vs private link depends on #12 |
| 15 | Environment separation | **UNCLEAR — BLOCKING** | no staging; `NODE_ENV` unvalidated; per-environment keys/servers undefined |

**What the owner must decide to unblock P7.1** — each is an infrastructure or operations policy
choice, not an engineering fact:

1. **TURN (Q65):** needed for the first real class? If yes: LiveKit's embedded TURN or a dedicated
   TURN server; its domain name; the certificate source; how public 443 is shared with the API's
   HTTPS on the one VPS (SNI routing, an L4 load balancer, or a second IP).
2. **Topology (Q65):** how LiveKit runs on the VPS (Docker with host networking, Docker with
   published ports and `node_ip`, systemd, or LiveKit Cloud) and whether the API reaches it over a
   private address (loopback or a Docker network) — which decides whether a separate server-side
   API URL is introduced (C3).
3. **TLS:** the public host names (API, LiveKit signalling, TURN), the TLS terminator, and the
   certificate source.
4. **Environments:** whether a staging environment exists; which `NODE_ENV` values are legal;
   separate LiveKit servers and keys per environment (and none shared with production).
5. **Reading of "`/rtc/validate` exists":** the approved design places the self-check *inside the
   adapter* (at boot and on every room sweep, driving Start's 503), with **no new application
   route**. Exposing it over HTTP would be a new decision: a coarse status contributed to the public
   `/health/ready` (a new platform seam), or an owner-only route under `settings.manage` (a Q1
   choice). The audit recommends the in-adapter self-check plus logs, and no new route, unless the
   owner decides otherwise.

## 9. Exact P7.1 implementation map (to execute once §8 is decided)

Each step is small and single-purpose; no file above ~400 lines.

1. **Adapter correctness (independent of the decisions):** S1 — a codeless 404 is misconfiguration;
   S6 — `mute` on a departed identity re-reads `getParticipant`; a falsy-TTL guard; explicit
   `ClientOptions { requestTimeout, failover: false }`; structured `live.provider.*` events
   (`initialize`, `health_check`, `room_create`, `room_delete`, `token_issue`, `error`) with ids
   only.
2. **Secondary identities (S2):** the observer maps `<userId>#<suffix>` to a non-person the
   reconciler removes at once; a real-server test.
3. **Configuration:** validate `LIVEKIT_URL` (parseable; `wss` required in production; required
   when `livekit` is enabled); refuse a LiveKit secret equal to `JWT_SECRET` or
   `STORAGE_SIGNING_SECRET`; validate `NODE_ENV` against the decided set; an optional
   server-side API URL only if decision 2 calls for it.
4. **Self-check:** a narrow port method (e.g. `RtcReadiness.check()` → `ready | auto_create_on |
   unauthorized | unreachable | misconfigured`), implemented in the adapter with LiveKit's
   `/rtc/validate` (Bearer header, a random room name of this deployment's form, a `roomJoin`-only
   token), run at boot and on each room sweep; Start answers 503 `live.media_unavailable` while not
   `ready`; logged once per transition, never the token or the secret. Exposure per decision 5.
5. **Server configuration files:** a small `infra/livekit/livekit.yaml` for development/CI
   (`room.auto_create: false`, `enable_remote_unmute: false`, `use_external_ip: false`, UDP mux or
   a narrow range, no TURN, no webhooks, keys only through `LIVEKIT_KEYS`) and a production template
   whose TURN, `node_ip`, domain and port choices follow decisions 1–3; a short README for local
   development. No secrets in any file or image.
6. **Real-server contract suite:** `test/integration/livekit-adapter.spec.ts` against the pinned
   binary in CI (checksum-verified download), covering the brief's real-server items 2–13 with
   `@livekit/rtc-node` as the client (publish refused for a listener, allowed for a speaker, screen
   allowed only for a presenter holding `live.speak`, a foreign room refused, `auto_create` off,
   secondary identities, provider failures), clearly separated from the fake and unit suites and
   never counted as skipped.
7. **Architecture:** extend the import-boundary spec to name every allowed SDK importer and to fail
   on any import from domain, application, contracts, HTTP, Communities or shared code; keep
   `@livekit/rtc-node` confined to tests.
8. **Documentation:** `docs/p7-livekit-readiness.md` (version, architecture, config, env vars,
   ports, TLS, TURN, token boundary, room policy, self-check, security, fake vs real, local setup,
   staging/production, what is not proven, next phase); correct the `createRoom` wording in
   `live.md`.

Out of scope throughout: Flutter (`app/` untouched), attendance, load testing, capacity (300 + 10
unchanged, not final), P7.2.

## 10. What this audit does not claim

- No production readiness: no TLS, TURN or public-network path was exercised; everything ran on
  127.0.0.1 with the real binary.
- No positive screen-share publish was run; no capacity figure of any kind was measured.
- The ICE-over-TCP-behind-TLS restriction is taken from the official sample configuration, not
  tested.

---

**P7.1 READINESS: BLOCKED**
