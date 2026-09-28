# P7.1 — LiveKit server configuration and provider readiness

**Date:** 2026-09-27; revised by P7.1.1 on 2026-09-28. **Repository state:** `cd6a7bb`.
**Scope:** P7.1 only: the LiveKit server configuration, its deployment files and the provider
readiness gate. No Flutter file (`app/`) changed, nothing of attendance, no change to the
300 + 10 limit, and no capacity claim of any kind.

The [readiness audit](p7-livekit-readiness-audit.md) (Phase 0, kept unchanged as the
historical record) ended **BLOCKED** on four infrastructure decisions. The user took them as
decisions A–H on 2026-09-27, recorded under
[Q65](architecture/open-questions.md#q65--media-hosting-and-operations). This document
describes what P7.1 built on them, what was verified and how, and what was not. **The
verdict is at the end.**

---

## 0. How to read it

- **SRV** is the LiveKit server source at tag v1.13.7 (`github.com/livekit/livekit`,
  `8d11efd`). **MTU** and **PGO** are `livekit/mediatransportutil` `f234b53` and
  `livekit/protocol` `a4f4b5c0c23f`, the revisions SRV's `go.mod` pins. **SDK** is the
  installed `livekit-server-sdk` 2.19.1. As in the audit, `docs.livekit.io` could not be read
  from this environment. Every LiveKit fact below was either read in these sources or
  observed by running the v1.13.7 binary.
- **VERIFIED** means read in source, or observed in the run named beside it. **CONFIGURED**
  means written in a committed file and checked statically, but never observed working.
  **NOT VERIFIED** means neither. **BLOCKED** (P7.1.1) means it could not be attempted: it
  waits on the host or on an owner decision.
- `live/…` means `backend/src/modules/live/…`. Other paths are from the repository root.

## 1. Decisions

The user's decisions A–H, in short (the full text is under Q65):

| | Decision |
| --- | --- |
| A | LiveKit is self-hosted. No LiveKit Cloud |
| B | It runs on our own infrastructure, initially the existing server, isolated from the API at the container boundary, and able to move to a dedicated media server later |
| C | It is deployed with Docker, from committed configuration |
| D | The API is the control plane and LiveKit the media plane. Every externally reachable LiveKit port and every API → LiveKit connection is documented |
| E | Clients use secure transport, through the existing TLS termination. No second certificate authority; production refuses `ws://` |
| F | TURN uses LiveKit's own mechanism, configured per environment and documented apart from SFU traffic |
| G | Development, staging and production each have their own LiveKit key, secret, URL and server. `JWT_SECRET` and `STORAGE_SIGNING_SECRET` are never the LiveKit secret |
| H | `/rtc/validate` stays an internal readiness check. There is no new public endpoint |

P7.1 turned them into ten engineering decisions. The code cites them as "P7.1, decision N".

| # | Decision | § |
| --- | --- | --- |
| 1 | The server is pinned at v1.13.7: the image by tag and digest, the release archive by sha256. With real media on, the API refuses to boot unless `LIVEKIT_VERSION` is `1.13.7` | 3 |
| 2 | `NODE_ENV` must be `development`, `test`, `staging` or `production`; anything else refuses boot. Staging and production are *deployed* environments and get production-grade checks | 10 |
| 3 | There are two URLs. `LIVEKIT_URL` is for clients: `wss://` only in staging and production, real media on or not. `LIVEKIT_API_URL` is for the API: `https://` there unless its host is internal | 6 |
| 4 | With real media on, the LiveKit key and secret must be set on purpose and the secret be at least 32 bytes. With real media on, and in staging and production always, the LiveKit secret must differ from the other two secrets. No secret or token is ever logged. The binding rule D19 is kept | 11 |
| 5 | A 404 means "not found" only when LiveKit itself says so. Everything else is an outage or a fault. The SDK's client options are stated explicitly. A token's lifetime is checked again in the adapter | 6, 12 |
| 6 | The identity contract: any standard participant whose identity the application never issued is removed | 13 |
| 7 | Readiness is checked through LiveKit's `/rtc/validate`, internally only, and gates Start | 15 |
| 8 | Structured `live.provider.*` log events | 11 |
| 9 | The Docker deployment and the environment contract. No TLS-terminator configuration and no firewall script are committed | 4, 5, 9 |
| 10 | File sizes. The 1,119-line reconciler is split with no change in behaviour | 2 |

## 2. Final architecture

```
Identity → Communities → Live: use cases, reconciler, LiveMediaReadiness
        → RTC ports (live/domain/rtc-provider.ts)
        → LiveKit adapter (live/infrastructure/livekit-*.ts)
        → LiveKit server v1.13.7 (its own container)
```

- **Control plane and media plane (D).** The API decides who may do what, signs each join
  token and keeps LiveKit in line with its record. Clients carry media to LiveKit directly
  (§6). LiveKit is never an HTTP service hidden behind the API.
- **The adapter is three files, the only code that imports the SDK:**
  `livekit-rtc-provider.ts` (rooms, tokens, participants), `livekit-readiness.ts` (the
  self-check) and `livekit-transport.ts` (the client options, error classification, and what
  of an error may be logged). The dependency rule `livekit-sdk-only-in-the-live-adapter`
  (`npm run arch:graph`) and `backend/test/architecture/live-boundaries.spec.ts` enforce
  this. The WebRTC client `@livekit/rtc-node` may never appear under `src/` (rule
  `webrtc-client-never-in-src`) and appears only under `backend/test/livekit/`
  (`livekit-suite.spec.ts`).
- **The ports.** Five narrow ports on one provider object, each bound with
  `useExisting: RTC_PROVIDER`. The fifth, `RtcReadinessProbe` (`RTC_READINESS`), is new.
- **The binding** (D19, tightened; `rtcProviderFor` in `live/live.module.ts`) is logged once
  at boot as `live.provider.initialize`:

  | Configuration | Binds | Its readiness |
  | --- | --- | --- |
  | `LIVEKIT_API_SECRET` is the development secret (its default) | the fake: no media | ready |
  | `LIVE_MEDIA_PROVIDER=livekit`, once configuration passes every check in §10–§11 | the LiveKit adapter | the self-check (§15) |
  | anything else, real credentials included | `DisabledRtcProvider`: every call refuses | `provider_disabled` |

- **Readiness.** `LiveMediaReadiness` (application layer) caches the provider's report. It is
  asked at boot, first in every room sweep, and by Start, which refuses with 503 while the
  provider is not ready (§15). A room sweep never reads a provider whose answers are positively
  not LiveKit's (§15).
- **The reconciler** was split by responsibility from one 1,119-line file into eight files,
  none longer than 401 lines. Its existing specs passed unmodified, with identical results
  before and after the split. The room sweep now refreshes readiness, and the participant
  step removes foreign identities (§13).

## 3. Version

**The LiveKit server is pinned at v1.13.7.** Everything that names the version reads, or is
checked against, one constant: `PINNED_LIVEKIT_SERVER_VERSION = '1.13.7'` in
`backend/src/platform/config/livekit-config.ts`.

| Where | What is pinned | How a mismatch is caught |
| --- | --- | --- |
| The application | With `LIVE_MEDIA_PROVIDER=livekit`, `LIVEKIT_VERSION` must equal the constant | Boot is refused |
| `infra/compose.yaml` | `livekit/livekit-server:v1.13.7@sha256:6fd3b7088874c4d119160dd688798dfec852bc014786d392caad15f6f63912a3`, by tag and digest | `compose-topology.spec.ts` builds the expected tag from the constant |
| `infra/env/*.env.example` | `LIVEKIT_VERSION=1.13.7` | `environment-contract.spec.ts`: it must equal the constant and the image's tag |
| The real suite | `livekit_1.13.7_linux_amd64.tar.gz`, sha256 `6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2` (`backend/test/livekit/support/pinned-release.ts`) | The suite refuses to run if the version differs from the constant, if the digest is wrong, or if the binary does not report `livekit-server version 1.13.7` |
| CI | The `livekit` job reads the version from the constant and caches the release under it | — |

- **Upgrading** means changing all of these together; the tests fail until they agree. Then
  `npm run test:livekit` must pass against the new release. No upgrade can happen silently.
- **Libraries.** The SDK is `livekit-server-sdk` 2.19.1 (the lockfile, installed with
  `npm ci`) with `@livekit/protocol` 1.51.0; audit §2 found them aligned with the server's
  protocol revision. The WebRTC client, `@livekit/rtc-node` **1.1.0** (pinned exactly), is a
  devDependency used only by the real suite.

## 4. Server topology

- **One host (A, B, C).** For now the existing server runs two containers from
  `infra/compose.yaml`: `api`, the NestJS API, and `livekit`, the pinned image. Postgres,
  Redis and the TLS terminator belong to the host and are not defined in these files.
- **LiveKit runs as a single node.** It has no Redis (so it uses single-node routing, and
  `REDIS_HOST` is never passed) and no webhooks, and nothing is configured for egress,
  ingress or SIP.
- **Isolated (B).** LiveKit has its own process, container and variables (§5). The API
  reaches it only over the compose network (§6).
- **Movable (B).** Moving LiveKit to a dedicated media server is a deployment change, not a
  code change: `LIVEKIT_URL`, `LIVEKIT_API_URL` (`https://`, or a private address, in a
  deployed environment), and that server's own compose file and `NODE_IP`. The domain and
  application layers know only the RTC ports.

## 5. Docker topology

Compose project `institution`, on its default bridge network (`institution_default`).
`infra/README.md` gives the commands for each environment.

| | `api` | `livekit` |
| --- | --- | --- |
| Image | Built from `backend/Dockerfile` in two stages on `node:22.23.3-alpine3.24`, pinned by digest. It runs `node dist/main.js` as the image's unprivileged `node` user, with `NODE_ENV=production` as the default. The runtime stage holds production dependencies and `dist/` only. No secret is baked in: `.dockerignore` is an allow-list of `package*.json`, `tsconfig*.json` and `src/` without specs. It never runs migrations | The pinned image (§3), run as `--config /etc/livekit/livekit.yaml`: the committed `infra/livekit/livekit.yaml`, mounted read-only |
| Environment | Only the API's settings. Fixed: `PORT`, `STORAGE_LOCAL_ROOT` and `LIVEKIT_API_URL=http://livekit:7880`. Required (`${VAR:?}`): `NODE_ENV`, `JWT_SECRET`, `STORAGE_SIGNING_SECRET`, `LIVEKIT_URL`, `LIVEKIT_VERSION`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. The rest are passed only when the environment file sets them | An allow-list: `LIVEKIT_KEYS` (`"<key>: <secret>"`, built from the API's own key and secret), `NODE_IP` (from `LIVEKIT_NODE_IP`), and, with the TURN override, the five `LIVEKIT_TURN_*`. Never `JWT_SECRET`, the storage secret, the database or an `env_file`. Any other `LIVEKIT_<PATH>` variable would override the policy file (§14) |
| Ports | `127.0.0.1:3000:3000/tcp` | `127.0.0.1:7880:7880/tcp`, `7881:7881/tcp`, `7882:7882/udp`; with the TURN override, also `3478:3478/udp` and `127.0.0.1:5349:5349/tcp` |
| Health check | `node` fetches `http://127.0.0.1:3000/health/ready` | busybox `wget` of `http://127.0.0.1:7880/`, which must answer exactly `OK`: LiveKit's own `GET /`, 200 `OK` or 406 `Not Ready` when its node statistics are stale (SRV `pkg/service/server.go:406-427`) |
| Restart | `unless-stopped` | `unless-stopped`, not `on-failure`: a fatal startup error exits with status 0 (SRV `cmd/server/main.go:190-192`) |
| Hardening | `no-new-privileges:true`, `cap_drop: [ALL]` | the same |
| Start order | `depends_on: livekit: condition: service_started`, ordering only: the API boots without LiveKit and answers Start with 503 until readiness passes | — |
| Storage | the named volume `api-storage` at `/app/.storage` | — |

No container is privileged, none sees the Docker socket, and none shares a host namespace
(`backend/test/deployment/compose-topology.spec.ts`). CI runs
`docker compose … config --quiet` for every environment, and for staging and production also
with the TURN override. That check is client-side: nothing is built or started.

## 6. Paths: client → LiveKit and API → LiveKit

**Client → LiveKit** (the media plane):

1. **The ticket.** `POST /live/sessions/:id/join` answers with `url` (= `LIVEKIT_URL`) and a
   120-second `token` (§12).
2. **Signalling.** The client opens a WebSocket to `url` (`/rtc`). In staging and production
   that is `wss://<LiveKit hostname>`: the TLS terminator receives it on public 443 and
   forwards it to `http://127.0.0.1:7880`, the container. In development it is
   `ws://localhost:7880`, straight to the loopback-published port.
3. **Media.** ICE runs to the address LiveKit advertises, `NODE_IP`: UDP 7882 first, TCP 7881
   as the fallback. Both are published one-to-one, so the advertised port is the published
   port. WebRTC encrypts the media itself (DTLS-SRTP).
4. **TURN**, in staging and production only: `turn:<NODE_IP>:3478` over UDP, and
   `turns:<TURN hostname>:443` over TLS through the terminator (§9).

**API → LiveKit** (the control plane):

- **The URL** is `LIVEKIT_API_URL`, which compose sets to `http://livekit:7880`: the compose
  network, so the traffic never leaves the host. A single-label service name counts as
  internal, so a deployed environment accepts plain HTTP to it (decision 3). Plain `http:` to
  a public host is refused at boot in staging and production, and the self-check would report
  it as `insecure_url` before sending anything. Without compose, `LIVEKIT_API_URL` may be left
  unset; it is then derived from `LIVEKIT_URL` (`ws→http`, `wss→https`).
- **What travels on it:** the Twirp room service (`/twirp/livekit.RoomService/*`), each call
  carrying a fresh admin token signed with the secret, lasting 10 minutes and granting
  `roomCreate`, `roomList` or `roomAdmin` (SDK `ServiceBase.ts`, `RoomServiceClient.ts`); and
  the self-check (§15): `listRooms`, then `GET /rtc/validate` with a join-only token in the
  `Authorization: Bearer` header.
- **Client options, stated explicitly** (`live/infrastructure/livekit-transport.ts`):
  `requestTimeout: 10` seconds and `failover: false`, one attempt per call. The self-check's
  own request has the same 10-second timeout and `redirect: 'manual'`.
- **How a failure is read.** *Absence*: only LiveKit's own answer, a 404 carrying the Twirp
  code `not_found`. *Outage*: a refused, reset or unresolvable connection, a timeout, or a
  5xx becomes `RtcUnavailableError`. *Fault*: rejected credentials, a TLS or certificate
  failure, a 404 without that code, or a body that is not LiveKit's. A fault is logged and
  never treated as success (audit S1 closed).

## 7. Ports

This is `livekit-server ports` from the v1.13.7 binary, run on the committed policy file for
this document:

```
$ livekit-server ports --config infra/livekit/livekit.yaml
TCP Ports
7880 - HTTP service
7881 - ICE/TCP
UDP Ports
%!s(int=7882) - ICE/UDP
```

With TURN, the override's values have to go into a copy of the file as a `turn:` block,
because `ports` does not read `LIVEKIT_*` variables (with them set, the output above is
unchanged):

```
TCP Ports
7880 - HTTP service
7881 - ICE/TCP
5349 - TURN/TLS
UDP Ports
%!s(int=7882) - ICE/UDP
3478 - TURN/UDP
```

`%!s(int=7882)` is an upstream formatting slip that means 7882: SRV
`cmd/server/commands.go:63-64` prints a number with `%s`. `ports` does not list the TURN
relay range or the host's 443.

| Port | Protocol | Purpose | Public / private | Required / optional |
| --- | --- | --- | --- | --- |
| 443 | TCP, TLS | The host's existing TLS terminator: the API (HTTPS and `/realtime`), LiveKit signalling (`wss://`), and TURN over TLS on the TURN hostname | public | required; the TURN hostname only with TURN |
| 3000 | TCP | The API, plain HTTP | private: host loopback, public only through 443 | required |
| 7880 | TCP | LiveKit's only HTTP port, plain HTTP: WebSocket signalling (`/rtc`, `/rtc/v1`), the Twirp server APIs, `/rtc/validate` and the `GET /` health check (SRV `pkg/service/server.go:145-153`) | private: host loopback, public only through 443. The API uses `livekit:7880` | required |
| 7881 | TCP | ICE over TCP, for media when UDP is blocked. It "cannot be behind load balancer or TLS" (SRV `config-sample.yaml:60`), and listens on every interface, whatever `bind_addresses` says (MTU `pkg/rtcconfig/webrtc_config.go:184-186`) | public, on every host interface | required by this configuration (LiveKit would allow `tcp_port: 0`; not chosen) |
| 7882 | UDP | ICE over UDP through one muxed port (`rtc.udp_port`), instead of the default 50000–60000 range | public | required |
| 3478 | UDP | Embedded TURN over UDP, advertised as `turn:<NODE_IP>:3478` | public | optional: only with the TURN override (staging, production) |
| 5349 | TCP | Embedded TURN over TLS. The terminator ends the TLS (`external_tls`); LiveKit advertises it as `turns:<TURN hostname>:443` | private: host loopback, public only through 443 | optional: only with the TURN override |
| 30000–40000 | UDP | TURN relay allocations, one port each: bound in LiveKit's network namespace and announced on `NODE_IP`. Their only peer is the SFU (SRV `pkg/config/config.go:671-681`, `pkg/service/turn.go:112-128`) | never public: no client sends to it | only with TURN. **The relay path is not sound on the bridge network (§18)** |

Nothing else listens. LiveKit opens a Prometheus port only when `prometheus.port` is set
(SRV `pkg/service/server.go:159-179`); the design's `prometheus_port` is not in the committed
file. The pprof debug handler needs `debug_handler.port` or development mode, and neither is
used (`:137-142`, `:181-194`). The UDP mux replaces the 50000–60000 range. Nothing in `infra/`
changes a firewall; §19 lists what the host must open.

## 8. TLS

| Hostname (as in the examples) | TLS ended by | Certificate owned by | Then |
| --- | --- | --- | --- |
| the API's | the existing TLS terminator, on public 443 | the terminator | `http://127.0.0.1:3000`, including the `/realtime` WebSocket |
| `LIVEKIT_URL`'s (`livekit.example.com`) | the terminator | the terminator | `http://127.0.0.1:7880`, with the WebSocket upgrade |
| `LIVEKIT_TURN_DOMAIN` (`turn.example.com`) | the terminator | the terminator | the decrypted TCP stream to `127.0.0.1:5349` |

- **LiveKit terminates no TLS and holds no certificate.** Its HTTP port is a plain listener
  (SRV `pkg/service/server.go:237-251`). TURN/TLS runs with `external_tls`, and LiveKit loads a
  certificate only without that setting (SRV `pkg/service/turn.go:211-222`).
- **No second certificate authority, and no terminator configuration committed** (E,
  decision 9). The terminator is the host's; `infra/README.md` states the contract above for
  it. For the TURN hostname it must end TLS on a raw TCP stream, not only on HTTP.
- **Media and the API → LiveKit path are not TLS.** WebRTC encrypts media itself: "WebRTC
  transports are encrypted and do not require additional encryption" (SRV
  `config-sample.yaml:61`). API → LiveKit is plain HTTP inside the compose network (§6).
- **Enforced in code.** In staging and production, `LIVEKIT_URL` must be `wss://`, real media
  on or not. In those environments `LIVEKIT_API_URL` must be `https://` unless its host is
  internal. The self-check repeats both checks before sending anything.
- **Not verified here (§18):** no certificate and no terminator exist in this environment.

## 9. TURN, separately from SFU traffic

**Ordinary SFU traffic needs no TURN.** A client's media goes to `NODE_IP:7882` over UDP, or
to `NODE_IP:7881` over TCP when UDP is blocked, encrypted by WebRTC. **TURN is for clients
whose network lets neither through**, such as some school and home networks.

- **The mechanism (F)** is LiveKit's embedded TURN, not a separate server. Only
  `infra/compose.turn.yaml` enables it, for staging and production, with
  `LIVEKIT_TURN_ENABLED=true`, `LIVEKIT_TURN_DOMAIN` (required), `LIVEKIT_TURN_UDP_PORT=3478`,
  `LIVEKIT_TURN_TLS_PORT=5349` and `LIVEKIT_TURN_EXTERNAL_TLS=true`. Each name is `LIVEKIT_`
  followed by the upper-cased config path (SRV `pkg/config/config.go:911`; the fields are at
  `:271-280`).
- **What clients are told.** Each client's join response carries
  `turn:<NODE_IP>:3478?transport=udp` and `turns:<domain>:443?transport=tcp`. LiveKit always
  gives 443 for TLS, whatever its own TLS port is (SRV `pkg/service/roommanager.go:1059-1070`),
  which is why the terminator takes TLS for the TURN hostname on 443.
- **Credentials.** LiveKit generates them per participant from the API key and secret and
  sends them in the join response, valid for 300 s by default (SRV
  `pkg/service/roommanager.go:1072-1083`; `turn.go:281-325`). The application never holds a
  TURN credential, and no environment file contains one.
- **Security boundary.** TURN refuses to relay to loopback, private, link-local, multicast or
  unspecified peers unless they are allow-listed (SRV `pkg/service/turn.go:134-160`); none is.
  One participant may hold at most 12 relay allocations (LiveKit's default).
- **Health.** TURN has no health check of its own. LiveKit logs `Starting TURN server` with
  its ports at startup, and the readiness check (§15) does not cover TURN.

| TURN | Status | Evidence |
| --- | --- | --- |
| The variable names are the ones v1.13.7 reads | VERIFIED | Source (above). The v1.13.7 binary, started with the committed policy file and these variables on loopback test ports, started TURN. Its log showed the TLS and UDP ports as given, `externalTLS: true` and relay range 30000–40000. This was a one-off run during P7.1, re-run for this document |
| A joining client is offered `turn:<NODE_IP>:<udp port>` and `turns:<domain>:443`, with a credential | VERIFIED, on loopback | The same run. With the TLS port at 36521, the client was still told `turns:turn.example.com:443?transport=tcp`. `/rtc/validate` still answered 404, and the server's log held no secret or token |
| `ports` lists 5349/TCP and 3478/UDP | VERIFIED | §7 |
| TURN ports are published only through the override, which requires the domain | CONFIGURED | `compose-topology.spec.ts`; `docker compose config` (development with the override is refused: the domain is missing) |
| A client relayed through TURN reaches the SFU | **BLOCKED** | The relay must see the SFU from `NODE_IP`. On the committed bridge network that path makes a hairpin through Docker's NAT, which presents the bridge gateway instead, whatever is published. Host networking gives the right addresses (source and lab, §18) |
| TURN over TLS through the real terminator on 443 | **BLOCKED** | needs a layer-4 TLS route for the TURN hostname on 443, and the terminator is not known (§18) |
| The client address TURN reports behind the terminator | **BLOCKED** | Without `proxy_protocol`, the proxy's address as LiveKit sees it: the bridge gateway on the bridge network, which Firefox accepts; 127.0.0.1 with host networking, which Firefox rejects (§18) |
| NAT traversal for real school and home networks | **NOT VERIFIED** | not run (§18) |

**Status: BLOCKED (§18).** On the bridge network the relay path is not sound: do not rely on TURN.

## 10. Environments and their contract

`NODE_ENV` must be `development`, `test`, `staging` or `production`; anything else refuses
boot (decision 2). **Staging and production are deployed environments** and get production's
checks; staging is checked exactly as production is, and only their values differ:

- the connections and secrets are required: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
  `STORAGE_SIGNING_SECRET`, `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`;
- no secret may be a placeholder;
- `JWT_SECRET` and `STORAGE_SIGNING_SECRET` must each be at least 32 bytes, and must differ;
  the LiveKit secret must differ from both, real media on or not (compose hands it to the
  LiveKit server either way), and with real media on be at least 32 bytes too;
- URLs must be secure: `LIVEKIT_URL` `wss://`; `LIVEKIT_API_URL`, if set, `https://` unless internal.

**Separation (G).** Each environment has its own LiveKit server, key, secret, hostnames and
room prefix; production's are never shared with staging, development or a load test (Q65).
Code enforces what it can: a deployed environment refuses placeholder and development
secrets (and, with real media on, a placeholder key), and the tests check that the three
examples use distinct hosts and prefixes. A real key
reused across two hosts is invisible to either one, so that rule is documented, not enforced.

The contract is in `infra/env/<environment>.env.example`. Each is copied to a git-ignored
`<environment>.env`, which then feeds compose's interpolation (never a container whole).

| | development | staging | production |
| --- | --- | --- | --- |
| Compose files | `compose.yaml` | `compose.yaml` + `compose.turn.yaml` | the same as staging |
| `NODE_ENV` | `development` | `staging` | `production` |
| `LIVE_MEDIA_PROVIDER`, `LIVEKIT_VERSION` | `livekit`, `1.13.7` | the same | the same |
| `LIVE_ROOM_NAME_PREFIX` | `live-development-` | `live-staging-` | `live-production-` |
| `LIVEKIT_URL` (clients) | `ws://localhost:7880` | `wss://livekit.staging.example.com` | `wss://livekit.example.com` |
| `LIVEKIT_API_URL` (API) | `http://livekit:7880`, set by compose | the same | the same |
| `LIVEKIT_NODE_IP` | `127.0.0.1` | the host's public IPv4 (a documentation address in the example) | the same as staging |
| `LIVEKIT_TURN_DOMAIN` | none: no TURN | `turn.staging.example.com` | `turn.example.com` |
| `DATABASE_URL`, `REDIS_URL` | empty: data kept in memory | the host's Postgres and Redis | the same as staging |
| `TRUST_PROXY`, `LOG_LEVEL` | `false`, `debug` | `1` (the terminator), `info` | the same as staging |

Every example ships `JWT_SECRET`, `STORAGE_SIGNING_SECRET`, `LIVEKIT_API_KEY` and
`LIVEKIT_API_SECRET` **empty**, and the compose files require each (`${VAR:?}`): as shipped,
compose refuses to render any example, so **no container starts until every secret is set**.
That matters for LiveKit above all: it would start on a known placeholder, only logging that
the secret is short (SRV `pkg/config/config.go:805-811`), and anyone knowing it could sign
tokens — `roomCreate` included — and derive TURN credentials. The deployment tests
(`environment-contract.spec.ts`) check that every secret ships empty and required, that neither
container's environment renders from an example as shipped, and that with generated secrets each
boots the API on real media while LiveKit is given the same key and secret. CI checks the same
with `docker compose … config`: each shipped example must be refused, and each must render once
secrets are supplied. `backend/.env.example` documents the same variables for running the API
without compose.

## 11. Secrets

| Secret | Read by | Rules the API enforces at boot |
| --- | --- | --- |
| `JWT_SECRET` | the API | Staging and production: required, not a placeholder, at least 32 bytes |
| `STORAGE_SIGNING_SECRET` | the API | The same, and different from `JWT_SECRET` |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | The API signs join, admin and probe tokens with them. LiveKit gets them only as `LIVEKIT_KEYS`, to verify those tokens | Staging and production: both required, the secret not a placeholder and different from `JWT_SECRET` and `STORAGE_SIGNING_SECRET`. With real media on: both set on purpose, neither a placeholder, the secret at least 32 bytes and different from both |
| TURN credentials | LiveKit only | Never configured anywhere (§9) |

- **Where secrets live:** each host's git-ignored `infra/env/<environment>.env`
  (`infra/.gitignore`), or the process environment. **Never:** in git, in an image (no build
  argument; `.dockerignore` is an allow-list), in the LiveKit policy file (no `keys` or
  `key_file`), in a log line, an HTTP response or an error message.
- **Their alphabet.** Use letters, digits, `-` and `_` for the key and the secret, because
  LiveKit reads `"key: secret"` as YAML. This is documented, not checked by configuration.
- **What the logs carry (decision 8):** ids and outcomes only.

| Event | Fields |
| --- | --- |
| `live.provider.initialize` | `provider`; for LiveKit also `apiHost`, `clientHost`, `roomNamePrefix`, `version` |
| `live.provider.health_check` | `status`, `reason`; once per change of state |
| `live.provider.room_create` | `room` |
| `live.provider.room_delete` | `room`, `outcome` (`deleted` or `already_gone`) |
| `live.provider.token_issue` | `room`, `identity`, `ttlSeconds`; never the token |
| `live.provider.error` | `operation`, the error's class, HTTP `status`, Twirp or platform `code`; never its message |
| `live.reconciler.foreign_identity_removed` | `sessionId`, `userId` (only when the part before `#` is an id), `outcome` |

Two kinds of test enforce this. `live/infrastructure/livekit-redaction.spec.ts` runs the
adapter against a stub that echoes the request's `Authorization` header and body back, plus a
room carrying a `turnPassword`; it scans everything written, console output included, for the
secret, `eyJ`, `Bearer`, every token issued and the TURN password, and finds none of them.
Every file of the real suite ends with the same kind of scan, over both the application's
logs and the LiveKit server's own log.

Two lines fall outside our logger:

- **The SDK's debug line.** The SDK writes one `console.debug` line when an error body claims
  to be JSON but is not. It quotes up to ten characters of the body on each side of the
  failure: for a body that echoes a token, the token's fixed header, never its claims or
  signature, and never the secret, which no request carries. The second test in
  `livekit-redaction.spec.ts` pins this.
- **LiveKit's 401 log.** LiveKit logs the API **key**, not the secret, when a request carries
  a key it does not know (SRV `pkg/service/auth.go:90-93`; audit S5).

## 12. Token contract

`/join` is the only issuer, and takes nothing from the client but the session id in the path.
The adapter signs HS256 with `iss` = the API key, `sub` = the **account id**, `name` from
`ACCOUNT_DIRECTORY`, and `exp` = `nbf` + **120 s**. The lifetime is checked twice, where it is
asked for and again in the adapter (a whole number from 1 to 600), because the SDK would turn
a falsy lifetime into six hours.

The grant is the same shape for every role: `room` = the server-derived
`<prefix><session id>[.<epoch>]`, `roomJoin`, `canPublish` exactly when the explicit
`canPublishSources` list is non-empty, `canSubscribe: true`, `canPublishData: false`,
`canUpdateOwnMetadata: false`, `hidden: false`. **Never** `roomCreate`, `roomAdmin`,
`roomList`, `roomRecord` or `agent`; `rooms.spec.ts` asserts this on a real ticket's claims.
The sources are total and explicit (`live/domain/standing.ts`, `capabilitiesFor`):

| Standing | May publish |
| --- | --- |
| listener | nothing |
| speaker (a student whose raised hand was granted) | the microphone, never a screen |
| moderator holding `live.speak` | the microphone, by right |
| … who also claimed the presenter slot | the microphone and the screen |
| moderator without `live.speak` | nothing |
| anyone | never the camera or screen audio |

- **Expiry and leeway.** The server accepts an expired token for a further **60 s**
  (PGO `auth/verifier.go:24, 79`), so a 120 s token is good for about 180 s after issue. The
  real suite shows a ticket issued 200 s ago refused ("token is expired") and one issued
  150 s ago still admitted. Once connected, LiveKit refreshes a client's token itself
  (live.md §9), so the 120 s bounds only the first connection.
- **Other tokens never reach a client:** the probe's token (identity `readiness-probe`, 30 s,
  `roomJoin` for the probe's own room and nothing else, sent only in a header) and the
  per-call admin tokens of §6.

## 13. Identity contract

The application issues exactly **one media identity per account: the account id**. The
client never chooses an identity, a suffix, a name or a room.

**The gap in LiveKit.** When a publish-capable token connects with a `publish` parameter,
LiveKit v1.13.7 appends `#<publish>` to its identity and joins it as an extra **standard**
participant, with the token's own publish rights and subscribing off (SRV
`pkg/service/utils.go:378-387`). No server option turns this off. A listener's token is
refused (401). The real suite shows both.

**The fix is on the server-controlled side** (decision 6; audit S2):

- **The domain rule.** `isIssuedParticipantIdentity` (`live/domain/live-ids.ts`) checks the
  Live id shape `^[A-Za-z0-9:_-]{1,128}$`, where `#` can never occur: the one definition of
  that shape, shared with `isLiveId`.
- **Removal.** The reconciler treats every observed standard participant that fails the rule
  as **foreign** and removes it at once (`removeParticipant`, revoking tokens issued before
  now), wherever it is observed: in the participant sweep's list, in the targeted watch, and
  in the whole-session check that a community's lock or unlock triggers (`checkSession`). The
  watch looks for it again every 10 s for 720 s (660 s until P7.2), extended on each removal.
- **Never a person.** A foreign identity is never passed to Communities or identity, and
  never given capabilities. P7.1 also kept it from ever triggering a media reset; P7.2's
  decision R1 amends that: its account counts it as its own breach, and a withdrawn
  publisher's reappearance resets the media ([P7.2 record](p7-livekit-media-integration.md) §3).
- **Logged and counted.** Each removal is logged `live.reconciler.foreign_identity_removed`
  with the session id and, only when the part before `#` is a valid id, that account id; the
  client-chosen string is never logged. Removals are counted as `foreignRemoved` in the
  participant sweep's and the watch's tick reports.

**The window that remains.** Until the next participant sweep (at most 60 s, or 10 s once the
watch remembers it) the extra participant holds exactly its token's rights, never more.
Removal does not stop the same token from connecting again, because the open-source server
ignores `revoke_token_ts` (live.md §9); that is why the watch keeps looking. The real suite
shows a removal by the sweep, and a second by the watch when the participant comes back,
while the real participant stays connected and publishing.

## 14. The `auto_create` policy

LiveKit's default is `auto_create: true` (SRV `pkg/config/config.go:563`). **The committed
policy pins `room.auto_create: false`**: a join, or a `/rtc/validate`, for a room that does not
exist is then refused with 404 unless the token carries `roomCreate` (SRV
`pkg/service/roomallocator.go:175-184`, `pkg/service/utils.go:389-397`). Only the application
creates rooms: Start (after the readiness check), a join's ensure-then-recheck, and the
reconciler's room sweep. The session is the authority and a room is infrastructure state
only: an ended session's room stays gone, and a token still within its lifetime cannot bring
it back.

| Way around the setting | Closed by |
| --- | --- |
| A token that carries `roomCreate` connects to a missing room anyway (audit F1) | No token the application issues carries it (§12). The real suite checks a real ticket's claims, and that the room API refuses that ticket |
| A `LIVEKIT_ROOM_AUTO_CREATE=true` variable overrides the file (SRV `config.go:911`, applied after the file at `:652-656`; audit F2) | The LiveKit container receives an allow-list of variables (§5, tested). At runtime the self-check reports `auto_create_enabled`, shown on a real server started with exactly that variable |
| `LIVEKIT_CONFIG` replaces the file outright (SRV `cmd/server/main.go:50-54`) | It is not in the allow-list |

A misspelt key such as `auto_creat` refuses startup (SRV `config.go:644-650`); a one-off run
showed the refusal, with the process exiting 0. LiveKit's empty and departure timeouts are
left at their defaults (300 s and 20 s) as a backstop only; the adapter sets both, to 1,200 s,
on every room it creates.

## 15. The `/rtc/validate` readiness check

**The port (H: internal only, no new HTTP route).** `RtcReadinessProbe.check()` answers
`{ ready: true }` or `{ ready: false, reason }`, the reason from a closed set:
`provider_disabled`, `insecure_url`, `unreachable`, `tls_failure`, `unauthorized`,
`auto_create_enabled` or `incompatible_response`. It never throws, and its report never
carries a URL, a key, a token or a provider message. The fake reports ready unless a test
scripts otherwise; the disabled provider always reports `provider_disabled`. The LiveKit
adapter (`live/infrastructure/livekit-readiness.ts`) runs these steps in order, stopping at
the first failure:

| Step | Answer | Report |
| --- | --- | --- |
| **a.** Before any request, in staging or production | `LIVEKIT_URL` is not `wss:`, or `LIVEKIT_API_URL` is plain `http:` to a host that is not internal | `insecure_url` |
| **b.** `listRooms([probe room])` with the API credentials | 401 or 403, or Twirp `unauthenticated` or `permission_denied` | `unauthorized` |
| | the connection was refused, reset, unresolvable or timed out, or the answer was a 5xx | `unreachable` |
| | the TLS handshake or the certificate failed | `tls_failure` |
| | any other answer: a 404 without `not_found`, a body that is not LiveKit's, not HTTP at all | `incompatible_response` |
| **c.** `GET {LIVEKIT_API_URL}/rtc/validate` with `Authorization: Bearer <probe token>` for the room `<prefix>readiness-<uuid>` | 404 whose whole body is `requested room does not exist`, LiveKit's own answer (SRV `pkg/service/errors.go:38`, written by `HandleError`, `utils.go:84-87`) | **ready**: `auto_create` is off |
| | 200 `success` | `auto_create_enabled` |
| | 401 | `unauthorized` |
| | anything else | `incompatible_response` |
| | a failed request | as in step b |

**The probe changes nothing.** `/rtc/validate` runs LiveKit's allocator check and creates
nothing (SRV `pkg/service/rtcservice.go:107-115`). A probe room can never be a session's room,
which is the prefix followed by a uuid. The probe token is never logged and never put in a
URL. LiveKit logs each probe's 404 at `warn` as `error handling request` for `/rtc/validate`
(SRV `pkg/service/utils.go:73-81`): one line per check, expected, and no fault.

**`LiveMediaReadiness`** (`live/application/live-media-readiness.ts`) keeps the last report and
when its check began, and runs one check at a time: a refresh asked for during a running check
shares it. It asks the provider **at boot**, without holding the boot up; **first thing in
every room sweep** (every 30 s), before the sweep reads anything; and **by Start**, through
`ensureFresh(30 s)`, just before `ensureRoom`. A room sweep whose check answers
`incompatible_response` reads nothing and decides nothing (it reports `skipped:
'provider_incompatible'`): an endpoint that answers but is positively not LiveKit — a wrong
`LIVEKIT_API_URL` that says `200 {}` to everything — would otherwise hand the sweep an empty
room list, every live session's room would look missing, and each session would be ended
`idle` (decision 5 applied to the room list). Every other not-ready reason reaches the sweep's
calls, which fail and skip on their own, as before. Tests:
`live-reconciler-readiness.spec.ts` and, against a real server beside a `200 {}` stub,
`test/livekit/answers.spec.ts`. While the report is not ready, Start answers **503 `live.media_unavailable` and
stores nothing**: no room, no session row, no audit entry, no event. Joins are not gated,
because a running session's room already exists.

`live.provider.health_check` is logged once per change of state, with the status and reason
only: at `warn` for `unreachable` and `provider_disabled`, at `error` for the
misconfigurations. Nothing about readiness reaches an HTTP response beyond that 503;
`/health/ready` still reports the process only.

**What the check does not prove:** that clients can reach `LIVEKIT_URL` (it checks only that
URL's scheme, and makes its requests to `LIVEKIT_API_URL`); the media ports, `NODE_IP` or
TURN; the TLS terminator's public side; capacity. A misconfiguration that appears between two
checks can go unnoticed for up to 30 s.

## 16. Test categories, and which ran

The brief's §10 names five categories, A to E. Its first version named four: "fake provider"
is C, "adapter unit" is A and B, "real LiveKit integration" is D, "deployment readiness" is E.

| Category | What stands in for LiveKit | P7.1's files | Ran |
| --- | --- | --- | --- |
| **A. Unit** | Nothing: rules, a stub probe, errors shaped as Node's fetch throws them | `platform/config/livekit-config.spec.ts`, `app-config.spec.ts`; `live/domain/live-ids.spec.ts`; `live/application/live-media-readiness.spec.ts`; `live/infrastructure/disabled-rtc-provider.spec.ts`; `live/live.module.spec.ts` | yes, in `npm test` |
| **B. Adapter contract** | The real adapter and the real SDK, against a mocked room service or a local stub HTTP server; never LiveKit | `live/infrastructure/livekit-rtc-provider.spec.ts`, `-rtc-provider-failures.spec.ts`, `-transport.spec.ts`, `-readiness.spec.ts`, `-redaction.spec.ts`; `test/api/live-security.api.spec.ts` (the real adapter's signed tokens, decoded) | yes, in `npm test` |
| **C. Fake provider** | The deterministic `FakeRtcProvider`, or the disabled provider | `live/application/start-live-session-readiness.spec.ts`, `live-reconciler-identities.spec.ts`, `-watch.spec.ts`, `-readiness.spec.ts`; `test/api/live-readiness.api.spec.ts`, `live-media-disabled.api.spec.ts`; every Live suite from P6, unmodified | yes, in `npm test` |
| **D. Real LiveKit integration** | Nothing: two servers of the pinned v1.13.7 release started from the committed policy file, and a real WebRTC client (`@livekit/rtc-node` 1.1.0) | `backend/test/livekit/`: `readiness`, `publishing`, `rooms`, `identities`, `answers`, `application` (6 files, 36 tests) | yes, with `npm run test:livekit` |
| **E. Deployment and readiness** | The committed files, read as their consumers read them | `backend/test/deployment/`: `compose-topology`, `environment-contract`, `livekit-policy`, `api-image` (4 files, 44 tests); CI's compose validation | yes, in `npm test` and `docker compose config` |
| **Architecture** | The dependency graph and the sources | `test/architecture/live-boundaries.spec.ts`, `livekit-suite.spec.ts`, `rules-match.spec.ts`; `npm run arch:graph` | yes |

**The real suite runs on its own, and is never skipped.** It has its own Jest configuration
and a global lifecycle that needs no developer action. It uses `LIVEKIT_SERVER_BINARY` if set;
otherwise it takes the archive cached in `backend/.cache/livekit/1.13.7/` (git-ignored) or
downloads the release, and verifies its sha256 either way. It starts both servers on free
ports, with the HTTP port bound to loopback; each gets only its allow-listed variables and a
random key and secret, and the second also gets `LIVEKIT_ROOM_AUTO_CREATE=true`. It stops both
at the end. Anything short of the pinned release fails the run. `npm test` excludes
`test/livekit/` rather than skipping it, and in CI the suite is a job of its own.

**What ran for this document (2026-09-27), on the P7.1 tree:** the main suite with Postgres,
**186 suites and 2,668 tests, all passed, 0 skipped** (17 suites and 333 tests more than
`4cdc9a9`'s 169 and 2,335); the real suite three times, **6 suites and 36 tests** each, in 15 to
17 s, leaving no server running; `docker compose … config --quiet` for every environment, and for
staging and production with the TURN override (development with it is refused: no TURN domain);
and `format:check`, `lint`, `typecheck`, `build` and `arch:graph` (390 modules, 2,006
dependencies, no violation). GitHub's own runs are in §18.

## 17. What was verified

**Against the real server, by the committed real suite** (repeatable, and run by CI). These
are the brief's 18 items (§10):

| # | Item | How it is shown |
| --- | --- | --- |
| 1 | A listener connects | A real client joins with `/join`'s ticket. The server holds the identity, the directory's name and the room exactly as the application issued them, with a listener's permission |
| 2 | A listener cannot publish the microphone | The server answers "no permission to publish track" and holds no track |
| 3 | A speaker can publish the microphone | A student whose hand was granted publishes it, and the server holds the track |
| 4 | A moderator with `live.speak` can publish the microphone | The host publishes it, by right |
| 5 | A moderator without `live.speak` cannot publish | That moderator holds a listener's permission, and the publish is refused |
| 6 | A promoted student cannot share a screen | The speaker's screen track is refused |
| 7 | A moderator with `live.speak` can share a screen | Refused before the presenter claim. After the claim, the same connection publishes a screen, and a fresh ticket carries it |
| 8 | No arbitrary room can be created | The ticket carries no admin grant. The room API refuses it (401). A valid token for a room never ensured is refused (404) and creates nothing |
| 9 | An unknown room cannot be joined | There is no ticket for an unknown session, and a signed token for its room is refused (404) |
| 10 | An ended room cannot be revived | The same ticket, still within its lifetime, is refused after End, and nothing is re-created |
| 11 | An identity suffix is removed | `student-1#<suffix>` is removed by the participant sweep, and again by the watch when it returns. The real participant stays and keeps publishing. There is no violation, no reset, and nothing the client chose appears in a log |
| 12 | Demotion revokes publishing | Revoking the floor through the use case makes the server take the microphone away |
| 13 | A malformed answer is never read as "room missing" | The pinned server's own not-found answers read as absence. A stub's HTML 404, its JSON 404 without LiveKit's code, and its HTML 200 are all faults. The reconciler pointed at the stub does nothing, and a push reports `pending` |
| 14 | A wrong endpoint is a provider failure | A stub gives `incompatible_response`; a closed port and the host `livekit.invalid` give `unreachable`. In each case Start answers 503 with nothing stored |
| 15 | An expired token is refused | Issued 200 s ago, it is refused; issued 150 s ago, within the 60 s leeway, it is admitted |
| 16 | Mismatched credentials fail readiness | A wrong secret, and an unknown key, each give `unauthorized`, and Start stores nothing |
| 17 | `auto_create=true` is detected | The second server gives `auto_create_enabled`, and Start stores nothing |
| 18 | A secure production URL is required | Staging and production refuse to boot with `ws://`. Past that check, the adapter reports `insecure_url`, and the server's log shows it received no request |

Items 13 and 14 compare the pinned server with endpoints that are, by definition, not
LiveKit; item 18 is a configuration check, confirmed by the server's log. The suite also
checks that the correct server is **READY** and Start makes the room, sized to the cap plus
the reserve; that the servers run the pinned release from the committed policy file; that the
whole application, booted over HTTP with real media enabled only by its environment, starts a
session and admits a real client; and, in every file, that neither side's log holds the
secret, a token or an `Authorization` header.

**By the main suite, on every run:** every configuration refusal by its message; error
classification on what the real SDK throws; every adapter method against answers that are not
LiveKit's; every readiness branch; `LiveMediaReadiness`'s transitions and single flight; the
Start gate with the fake and the disabled provider; the foreign-identity rule and the
reconciler's handling of it; the deployment files (E) and the architecture rules.

**By one-off runs during P7.1** (throwaway scripts outside the repository): every readiness
answer against the real binary (ready, `auto_create_enabled`, `unauthorized`, `unreachable`,
`tls_failure` for `https://` to a plain port, `incompatible_response`); the pinned image,
pulled by digest, reports 1.13.7 and carries busybox `wget`; the image's and the release's
binary each start on the committed `livekit.yaml` with every capability dropped, and the
compose health command exits 0 while the server is up and 1 after; the API, built as the
Dockerfile builds it and started with compose's rendered environment, logs `health_check:
ready` against the real LiveKit, stays healthy and reports `unreachable` with LiveKit down, and
refuses to boot with only `NODE_ENV=production`; `livekit-server ports` (§7) and the TURN boot
(§9) were re-run for this document.

**Mutation checks** (each check broken on purpose, a failing test confirmed, the check
restored; the tables are not committed): 13 of 13 for the reconciler and the identity rule; 52 of
52 for the deployment files; 13 of 13 source and 6 of 6 architecture mutations against the real
suite, from `roomCreate` in a token and `auto_create: true` to any 404 read as not found; an
independent review's 18 critical checks; the room sweep's `incompatible_response` gate; and the
empty example secrets.

## 18. Deployment verification (P7.1.1)

P7.1.1 (2026-09-28) set out to verify on the intended server what §17 could not. **The server
could not be reached, so nothing was deployed, inspected or changed on it:** the record names it
only as "the existing server", one VPS (decision B), and P7.1.1's environment had no SSH key or
client and no Docker daemon. Full record: [p7-livekit-deployment-verification.md](p7-livekit-deployment-verification.md).

| Item | Result |
| --- | --- |
| Deployment host topology | **BLOCKED.** Recorded: one VPS, Docker, the existing TLS terminator. Not known: the host, its Docker version and `userland-proxy` setting, whether `NODE_IP` is on a host interface, the terminator |
| Docker | **BLOCKED.** CONFIGURED (§5), and compose validated on GitHub. Docker Hub serves `v1.13.7` as the committed digest (a registry query only). Nothing ran on the host |
| TLS | **BLOCKED.** Terminator, hostnames, certificates and chain not known; `wss://` is enforced in configuration only (§8) |
| Firewall | **BLOCKED.** No rule read and none opened; no before/after record exists |
| TURN | **BLOCKED.** The pinned source and a lab reproduction show that the committed bridge network cannot give the relay path the addresses it needs (below). Waits on an owner decision, then a host test |
| TURN over TLS | **BLOCKED.** Needs a layer-4 TLS route for the TURN hostname on 443, chosen by SNI. Whether the terminator has one is not known |
| `proxy_protocol` | **BLOCKED; off.** Not needed on the bridge network, where Firefox accepts the gateway address; required with host networking, where it would see 127.0.0.1 |
| External client | **NOT VERIFIED.** Nothing is deployed; §17's checks ran on loopback only |
| NAT/TURN | **NOT VERIFIED.** Networks A, B and C were not tested |
| GitHub CI | **VERIFIED.** Push runs #50 (`cd6a7bb`) and #51 (`8daab01`), and #52 (`workflow_dispatch`, 2026-09-28, `8daab01`): Backend (verify with Postgres, build, deployment files), real LiveKit (6 suites, 36 tests) and Flutter all succeeded |

**The TURN decision it needs.** The relay range needs no public exposure: its only peer is the
SFU. But the relay and the SFU share the container while `NODE_IP` is the host's, so every packet
between them makes a hairpin through Docker's NAT, and Docker (27.5 to 29.8, either firewall
backend, either `userland-proxy` setting) shows the SFU the bridge gateway, not `NODE_IP`. With
Docker 27's default proxy the relay then drops the SFU's replies; otherwise the SFU pairs through a
peer-reflexive address, which LiveKit treats as unsupported by Firefox. Publishing the range
changes neither, and would start about 20,000 `docker-proxy` processes. With host networking the
path is local and correct (lab, a pion client), but that is a topology change and the owner's
call: it also needs `rtc.ips` limited to `NODE_IP`, `bind_addresses` for 7880, a new private
API → LiveKit address, and `proxy_protocol` on. The range is sized after that choice; the default
30000–40000 overlaps Linux's ephemeral range by 7,233 ports.

**What unblocks it:** the host and a way to run the read-only checks on it; the owner's choice
of LiveKit's network mode, then `proxy_protocol`, the relay range and a limit on TURN peers
(LiveKit's TURN admits any public peer, not only `NODE_IP`); the terminator's layer-4 route for
the TURN hostname, and the firewall; then the runtime checks, external clients and networks.

## 19. Still open, and next

- **Capacity.** Nothing was measured: 300 + 10 is unchanged, with no claim for 3,000 per room or
  10,000 concurrent users. One UDP mux port is configured, where LiveKit's sample recommends a
  range at least as large as the host's vCPUs (SRV `config-sample.yaml:83-84`). That is P8's.
- **Not in the real suite** (live.md §22; P7.2 added `DUPLICATE_IDENTITY` and two prefixes on
  one server): the refreshed token's lifetime; a join refused above `maxParticipants`;
  `createRoom` on a live room returning it unchanged (seen only in the audit's run); latency at
  300, 1,000 and 3,000; which ICE transport carried the media.
- **Audit S6 is unchanged.** Muting an identity that leaves between the adapter's read and its
  mute answers 503 and becomes an outage. No caller uses mute yet (Q64).
- **Not decided, and not added:** Docker log rotation; the host's UDP buffer sizes (LiveKit
  warns when they are small); a key and secret alphabet check in configuration.
- **Not started:** P7.2, the Flutter live phase (the design's P7), the media client and device
  binding (P7b), load tests (P8) and attendance.

---

**P7.1 READINESS: PASS** for code and architecture, accepted on 2026-09-28, on the evidence of
§16–§17: the server version pinned and its configuration committed; `auto_create` off and
self-checked; secrets separated, never logged, and shipped empty; real media only when enabled
by name, Start waiting for the readiness check; the SDK inside the adapter; the token,
permission, identity and screen-share contracts proven against the real v1.13.7 server; every
test passing, none skipped. Real media stays off unless enabled; TURN must not be relied on.

**P7.1.1 DEPLOYMENT VERIFICATION: BLOCKED** (§18): Docker, TLS, firewall, TURN, TURN over TLS
and `proxy_protocol` BLOCKED; external clients and NAT/TURN NOT VERIFIED; GitHub CI VERIFIED.
