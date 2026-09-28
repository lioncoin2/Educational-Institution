# P7.1.1 — LiveKit deployment verification

**Date:** 2026-09-28. **Repository state:** `8daab01` (P7.1, accepted for code and
architecture). **Scope:** P7.1.1 only. It verifies on the intended server what P7.1 could only
configure. This phase changed no code and no configuration. It did not touch Flutter,
attendance, LiveSession semantics, tokens or the 300 + 10 limit. LiveKit stays at v1.13.7.

**Verdict at the end: P7.1.1 STATUS: BLOCKED.** The intended server could not be reached, so
nothing was deployed, inspected or changed on it. Three things could be settled without it:
- GitHub CI is **VERIFIED** (§4).
- The TURN relay-range and `proxy_protocol` questions are answered from the pinned sources
  and lab reproductions, not from the host (§5, §6). The answers show that **the committed
  bridge topology cannot carry TURN-relayed media correctly**, which needs an owner decision.
- The repository's secret history is clean (§7).

[The readiness document](p7-livekit-readiness.md) §18 carries the summary.

---

## 0. Words and sources

- **VERIFIED**, **CONFIGURED** and **NOT VERIFIED** mean what they mean in the readiness
  document. **BLOCKED** means the step cannot start until the host, or an owner decision,
  exists.
- **Source** means code read at pinned versions:
  - LiveKit v1.13.7 (**SRV**), `pion/turn` v5.0.13 (**TURN**), `livekit/ice` v4.4.0-warp.2
    (**ICE**) and `livekit/mediatransportutil` `f234b53` (**MTU**). Their hashes equal
    LiveKit's `go.sum`.
  - Docker Engine (**MOBY**): v27.5.1, v28.0.0, v28.5.2, docker-v29.0.0 and docker-v29.8.1,
    the latest stable release.
  - Linux v5.15 to v7.2.
  - Firefox 157's ICE code (nICEr).
  - The terminators named in §6.
- **Lab** means throwaway reproductions in network namespaces of the environment this phase
  ran in. None is committed. They used:
  - harnesses built from the modules above, with LiveKit's own TURN setup and permission
    handler and pion clients, not a browser;
  - the pinned LiveKit binary built from its source;
  - Docker's own firewall rules, taken from moby's test fixtures, with real `docker-proxy`
    binaries, but no Docker daemon.

  **No lab ran on the host or on Docker.**
- An independent adversarial review re-read every cited location. Its corrections are
  included.

## 1. The items, as the record gives them

The brief says "four" items and lists five. All five are taken as listed:
1. Docker runtime
2. TLS termination
3. TURN relay range
4. TURN over TLS / `proxy_protocol`
5. GitHub CI

The P7.1 record (readiness §18–§19 at `8daab01`) lists the same five. It adds external clients
and NAT traversal, which are the brief's §9–§10, and capacity, which is P8's and out of scope.

## 2. Access

- **The target.** The record names it only as "the existing server", one VPS (Q65, decision
  B; [hub §20.2](architecture/communities-live-attendance.md#202-the-single-vps-and-the-path-beyond-it)).
  No hostname, address, provider or access method is written anywhere in the repository.
- **This environment** has:
  - no SSH key and no SSH client;
  - no Docker daemon (starting one here would have created a second platform).
  A query of its network policy was refused by its permission system and was not pursued.
  Generic cloud-credential variables exist in it; nothing links the VPS to them, and they
  were not used.
- **So nothing on the host was touched.** Its Docker, containers, reverse proxy, firewall,
  ports, DNS, certificates and conventions were not read. No firewall rule was recorded,
  before or after. Nothing was opened, flushed or replaced, and no service was stopped.

## 3. Results

| Item | Status | Evidence, and what it waits on |
| --- | --- | --- |
| Host topology | BLOCKED | Recorded: one VPS, Docker, the existing TLS terminator. Not known: the host, its Docker version and `userland-proxy` setting, whether `NODE_IP` is on a host interface, the terminator (§8) |
| Docker | BLOCKED | CONFIGURED (readiness §5); compose validated on GitHub (§4). Docker Hub serves `livekit/livekit-server:v1.13.7` as the committed `sha256:6fd3b7088874…63912a3`, an OCI index (registry query, 2026-09-28). Not observed: pull and start on the host, health checks, published ports, API → `LIVEKIT_API_URL`, the readiness line |
| TLS | BLOCKED | Hostnames, terminator, certificates and chain not known. `wss://` and a private 7880 are enforced in configuration only |
| Firewall | BLOCKED | No rule read; none opened |
| TURN | BLOCKED | §5: the committed bridge network cannot give the relay path the address it needs. Waits on the owner's choice of network mode, then a host test |
| TURN over TLS | BLOCKED | §6: needs a layer-4 TLS route for the TURN hostname on 443. Whether the terminator has one is not known |
| `proxy_protocol` | BLOCKED; off | §6: required only with host networking. Waits on §5's decision and the terminator |
| External client | NOT VERIFIED | Nothing deployed. The checks ran only against the pinned server on loopback (readiness §17) |
| NAT/TURN (A, B, C) | NOT VERIFIED | Not run: direct ICE, TURN/UDP and TURN/TLS from real networks |
| GitHub CI | VERIFIED | §4 |

## 4. GitHub CI

These are the actual GitHub runs of workflow `CI` (`.github/workflows/ci.yml`), not local runs:

| Run | Event | Commit | Backend | Backend — real LiveKit | Flutter app |
| --- | --- | --- | --- | --- | --- |
| #50 | push, 2026-09-27 | `cd6a7bb` | success | success | success |
| #51 | push, 2026-09-27 | `8daab01` | success | success: 6 suites, 36 tests, 24.0 s | success |
| #52 | `workflow_dispatch` by P7.1.1, 2026-09-28 | `8daab01` | success | success | success |

How the brief's CI items map onto the jobs:
- **Backend verify, the architecture checks and the deployment tests** are the Backend job's
  `Verify` step: `npm run verify` against a Postgres 16 service, including `arch:graph`, the
  architecture specs and the deployment specs.
- **Compose validation and the secret checks** are its `Validate deployment files` step. Each
  shipped example must be refused while its secrets are empty, and each must render once they
  are supplied.
- **The real-server suite** is its own job. The pinned release is restored from a cache keyed by
  its version and checked by sha256.

Two gaps:
- The Backend job's test counts were not extracted: the log's tail is the Postgres service's
  output. That output shows the constraint tests running against PostgreSQL 16.15.
- GitHub warns that the actions it uses target Node 20. The warning is informational only.

## 5. The TURN relay range

**What v1.13.7 does with it (source, lab).**
- **Every TURN allocation takes one relay port.** That holds whether the allocation came over
  TURN/UDP on 3478 or over TURN/TLS through 5349 with `external_tls`. Each binds one UDP socket
  in LiveKit's network namespace, on a random port in `relay_range_start`–`relay_range_end`.
  The default is 30000–40000, or 30000–30002 in development mode. The port is announced to the
  client as `NODE_IP:<port>`. One generator serves both listeners (SRV `turn.go:112-129,
  165-201`; `config.go:598-604, 671-681`).
- **Allocation.** A port is drawn at random up to 50 times, and after that the client gets 508
  (SRV `turn.go:45`; lab).
- **In a session, the relay's peer is the SFU at `NODE_IP:7882`.** The SFU advertises exactly
  one UDP candidate: a host candidate rewritten to `NODE_IP`, with the container's own address
  never advertised (MTU `webrtc_config.go:89-117, 257-285`; ICE `external_ip_mapper.go:111-122`).
- **No client ever sends to the relay range**, so it never needs to be public.

**What the relay ↔ SFU path needs (source, lab).**
- **TURN's filter.** TURN admits a peer's datagram only on one of:
  - a channel bound to its exact IP:port;
  - a permission for its IP, which the client creates for `NODE_IP`, the only SFU address it
    knows.

  Anything else is dropped with an INFO log (TURN `allocation.go:83-89, 375-433`).
- **The SFU's filter.** The SFU learns an unexpected source as a peer-reflexive candidate and
  answers it. It accepts a response only from the address it sent to, and media only from a
  known address (ICE `agent.go:1809-1859`; `selection.go:22-26, 178-188`).
- **Firefox needs more.** LiveKit treats Firefox as not supporting "prflx over relay" (SRV
  `pkg/rtc/clientinfo.go:57-59`; `transport.go:411, 427-452`). For Firefox, the SFU must
  therefore see relayed packets from exactly `NODE_IP:<port>`. Otherwise the SFU's answers give
  the client a mapped address that differs from its relay candidate. Firefox's own handling of
  that was not read, so this conclusion is **INFERRED**.

**Docker's bridge network (source, lab).** In the committed topology the relay and the SFU share
one container, but the SFU's socket is bound to the container's own address and `NODE_IP` is not
in the container. So every relay ↔ SFU datagram leaves for the host's own address and has to
come back. For a container sending to its own published port 7882:

| Docker | SFU sees the relay from | Relay sees the SFU from | Outcome |
| --- | --- | --- | --- |
| 28.0 or later, default `userland-proxy` | the bridge gateway, via `docker-proxy` | `NODE_IP:7882` | Pairs only through a peer-reflexive gateway address: no Firefox (INFERRED). The host's INPUT policy must admit UDP from the bridge (lab: a rule dropping new traffic from it broke the path; external clients, forwarded rather than delivered, would not notice: INFERRED) |
| 27.x, default `userland-proxy` | the bridge gateway, via `docker-proxy` | the bridge gateway `:7882` | The relay drops the replies: relayed ICE fails |
| any, `userland-proxy: false` | the bridge gateway (MASQUERADE) | `NODE_IP:7882` | As 28.0, and it sets `route_localnet` on the bridge (lab: a container keeping the default `CAP_NET_RAW` reached a host service bound to 127.0.0.1; ours drop every capability) |
| gateway mode `routed` | — | — | No mapping: fails |

Sources for the table: MOBY `iptabler/port.go:91-100`, `cmd/docker-proxy/udp_proxy_linux.go`
(`IP_PKTINFO` since 28.0.0); lab.

- **The SFU's own checks** to `NODE_IP:<port>` reach nothing: the port is not published, and the
  host answers port-unreachable.
- **Publishing the range fixes nothing**, because the relay still sees the gateway. With the
  default proxy it would also start one `docker-proxy` per port and address family, up to about
  20,000 processes (Compose expands ranges per port; MOBY `daemon/network.go:1057-1085`).
  moby#11185 (2015, Docker 1.x) reports the daemon exhausting RAM for exactly this range.
  Docker's documentation recommends host networking for large port ranges
  (`engine/network/drivers/host.md:29-34`).
- **An assumption.** All of the above assumes `NODE_IP` is on a host interface. Where a provider
  maps the public address one-to-one instead, the hairpin is the provider's and was not
  analysed.

**Host networking (source, lab).** With LiveKit in the host's network namespace and `NODE_IP` a
host address, the relay and the SFU exchange `NODE_IP:<port> ↔ NODE_IP:7882` by local delivery,
and every condition above holds. The lab connected and carried media both ways, with the SFU's
selected remote exactly the relay candidate (a pion client, not a browser; not Docker, not the
host). It is not a drop-in change:
1. **The UDP socket.** With several IPv4 addresses on the host (Docker's bridges add some), the
   SFU binds 7882 once per address but serves only the first, in an order fixed at start. UDP
   ICE, relayed or direct, then fails whole on some starts (lab). `rtc.interfaces` or `rtc.ips`
   must include only `NODE_IP` (MTU `udpmultimux.go:58-76`; ICE `udp_mux.go:588-596`).
2. **Port 7880** would listen on every host address unless `bind_addresses` limits it.
3. **The API** could no longer use `http://livekit:7880`. It would need a private host address.
4. **`proxy_protocol`** becomes required (§6).
5. **The relay range** then shares the host's ephemeral ports (below).

Decision B asked for isolation at the process and container boundary. Host networking keeps
LiveKit in its own container but shares the host's network: that is the owner's call.

**The brief's questions.**

| Question | Answer | Basis |
| --- | --- | --- |
| Does v1.13.7 need the relay range in the chosen TURN mode? | Yes: TURN/UDP and TURN/TLS allocations both take ports from it | source, lab |
| Can Docker's bridge network expose it correctly? | No. Publishing does not help, because the path's source address is rewritten | source, lab |
| Is host networking required? | For a relay path that works for every client, yes. The other way is a TURN server of its own, which was not analysed | source, lab |
| Do the firewall rules allow it? | Not known. The range never needs to be public; with host networking the path is local | — |
| Does the provider allow it? | Not known. Both topologies need `NODE_IP` on a host interface | — |
| Does it conflict with another service? | Not known on the host. The default overlaps Linux's default ephemeral range, 32768–60999, by 7,233 ports | Linux `af_inet.c` (v5.15 to v7.2) |

**The range size, not chosen.**
- **Demand.** One port per allocation, and at most 12 per participant (LiveKit's quota; SRV
  `config.go:63-67`, `turnquota.go`). The typical figure is 4: two peer connections times two
  URLs. That client behaviour is NOT VERIFIED. A UDP allocation the client does not release
  lingers up to 10 minutes.
- **Sizing.** With 50 random tries, an allocation fails with probability (occupancy)^50: 3·10⁻⁴
  at 85% occupancy, 5·10⁻³ at 90%. So the range should hold at least the concurrent allocations
  ÷ 0.85.
- **Why it is not chosen.** The smallest valid range depends on the network mode, which is open.
- **With host networking,** a range below the ephemeral range avoids the overlap. For example,
  30000–32767 gives 2,768 ports, about 590 concurrent relayed participants at 4 allocations
  each. The alternative is reserving the range with `net.ipv4.ip_local_reserved_ports`.
- Nothing is configured.

## 6. TURN over TLS and `proxy_protocol`

**`external_tls` (source, lab).**
- `tls_port` is a plain TCP listener carrying TURN framing, and LiveKit loads no certificate
  (SRV `turn.go:211-246`; the pinned binary run with the committed policy and the override).
- Clients are always told `turns:<domain>:443?transport=tcp`, because 443 is a literal (SRV
  `roommanager.go:1068-1070`). The sample configuration's line saying `tls_port` is advertised is
  wrong.

**What the terminator must do (source, lab):**
1. Accept TLS on public 443 for the TURN hostname, with its certificate.
2. End TLS at layer 4 and relay the raw bytes to `127.0.0.1:5349`. An HTTP proxy cannot do this:
   the first bytes are a STUN Allocate, and pion closes or stalls on anything else (lab).
3. Choose the route by SNI where 443 also serves HTTPS.

| Terminator | Layer-4 TLS termination, routed by SNI | Sends PROXY | Read at |
| --- | --- | --- | --- |
| nginx | `stream`, `listen … ssl`; `server_name` (1.25.5+) or `ssl_preread` | v1 (`proxy_protocol on`); v2 only from mainline 1.31.4 | source |
| HAProxy | `mode tcp`, `bind … ssl crt`, `ssl_fc_sni` | `send-proxy`, `send-proxy-v2` | 3.4.0 manual |
| Traefik | TCP router with `tls`, `HostSNI` | `proxyProtocol` 1 or 2 (default 2) | v3.7.13 |
| Caddy, standard build | no: its proxy is HTTP-only | HTTP transport only | v2.11.4 |
| Caddy with `caddy-l4` | yes (an experimental plugin) | v1, v2 | v0.1.2 |

**`proxy_protocol` (source, lab).**
- **Without it,** the address TURN echoes to the client (XOR-MAPPED-ADDRESS) is the TCP peer
  LiveKit sees.
- **With it,** the header is read first. It is required from `turn.proxy_protocol_trusted_cidrs`,
  whose default is `127.0.0.0/8, ::1/128` and which can be set in YAML only. Other sources are
  closed at accept, and connections without the header are closed on first read (SRV
  `turn.go:208-265`; `go-proxyproto` v0.15.0).
- **What Firefox rejects.** Firefox 157 rejects a loopback, link-local or wildcard
  XOR-MAPPED-ADDRESS and abandons the allocation. A private address passes (nICEr
  `stun_client_ctx.cpp`, `transport_addr.cpp`). LiveKit's own comment names only loopback and
  wildcard.
- **Where the terminator's connection appears** decides whether Firefox is affected:
  - on the bridge network it comes from the bridge gateway, a private address, in both proxy
    modes (MOBY; lab), which Firefox accepts;
  - with host networking it comes from 127.0.0.1, which Firefox rejects.
- **Turning it on has costs:**
  - The trusted list must match what LiveKit sees. On the bridge that is the gateway, and under
    `docker-proxy` trusting the gateway trusts every host process.
  - A trusted sender can delete other clients' allocations by announcing their addresses and
    closing (lab).
  - A mismatch closes every TURN/TLS connection silently, while a TCP-connect probe on 5349
    still passes.
  - A v1 header must arrive in one read, so v2 is preferable.

**Decision: `proxy_protocol` stays off.**
- In the committed bridge topology nothing requires it (Firefox accepts the gateway address),
  and it only adds the risks above.
- If host networking is chosen (§5), it becomes required, with the default loopback list and a
  terminator that sends PROXY v2.
- So it follows §5's decision and the terminator. Both are open.

## 7. Security

- **The repository: VERIFIED.** No real secret was ever committed. The scan covered all 69
  commits of both branches, `main` and this one. Every committed value of `LIVEKIT_API_SECRET`,
  `LIVEKIT_API_KEY`, `LIVEKIT_KEYS`, `JWT_SECRET` and `STORAGE_SIGNING_SECRET` is one of:
  - empty;
  - a placeholder;
  - a `${…}` interpolation;
  - one of CI's throwaway values;
  - a spec fixture.

  No private key or certificate was ever committed. GitHub's own secret scanning is not enabled
  on the repository, because it needs GitHub Advanced Security.
- **The deployed system: not observed.** That covers the image's contents, the containers' logs,
  the Docker socket and privileges, the public ports and the production URL. Each is CONFIGURED
  and tested statically (readiness §5, §11).
- **A TURN property to decide.** LiveKit's permission handler admits any public peer, not only
  `NODE_IP` (SRV `turn.go:131-163`). So a participant with TURN credentials can relay UDP to
  arbitrary public addresses, up to 12 allocations. The credentials arrive in LiveKit's join
  response and are valid for 300 s for a new Allocate. Limiting peers to `NODE_IP` would need
  `turn.deny_peer_cidrs` covering the rest of the address space. That is an owner decision, and
  nothing is configured.

## 8. What unblocks P7.1.1

1. **The host and a way in:** its address, plus SSH access this environment can use, or an
   operator who runs these read-only checks and returns the output:
   - `docker version` and `/etc/docker/daemon.json` (`userland-proxy`, `firewall-backend`);
   - `ip -4 addr`: is `NODE_IP` on an interface?
   - `docker ps`;
   - `ss -lntup`;
   - the firewall ruleset;
   - the terminator's configuration;
   - DNS records;
   - the certificates in use.
2. **The owner's decisions:**
   - LiveKit's network mode for TURN: host networking with §5's changes, or the bridge without
     Firefox relays, or a TURN server of its own (to be analysed);
   - then `proxy_protocol` (§6), the relay range (§5) and TURN peer limits (§7).
3. **The terminator.** Its layer-4 route for the TURN hostname on 443, chosen by SNI, and the
   signalling route with WebSocket upgrades, using the existing certificate issuer. If it is
   standard Caddy, it cannot carry TURN over TLS, and that is a stop condition: the proxy is not
   replaced automatically.
4. **The firewall.** 443/TCP, 7881/TCP, 7882/UDP and 3478/UDP public, and nothing else of the
   stack's. The relay range is never public. Rules recorded before and after.
5. **Then the checks themselves:**
   - the runtime checks: images, health, readiness `ready`, API → LiveKit, no public 7880, no
     secret in logs;
   - clients from outside over `wss://`;
   - networks A, B and C.

---

**P7.1.1 STATUS: BLOCKED** — the intended server could not be reached.
- Docker, TLS, firewall, TURN, TURN over TLS and `proxy_protocol`: BLOCKED.
- External client and NAT/TURN: NOT VERIFIED.
- GitHub CI: VERIFIED.

Real media stays off unless enabled, and TURN must not be relied on.
