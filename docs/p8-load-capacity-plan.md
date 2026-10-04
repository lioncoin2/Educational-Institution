# P8 — Load & Capacity Test Plan (Phase 0: read-only audit)

> **Errata (2026-10-04, approved D-10):** corrections to P8.3 conclusions and to findings F2, F3 and §11 of this plan are recorded in [p8/p8.3-errata.md](p8/p8.3-errata.md); this document is otherwise unchanged.

**Date:** 2026-10-04. **Status: PLAN — nothing executed, nothing changed.** This is the read-only Phase-0
output: an evidence-based audit of the live P7.3 staging deployment and the P8 load/capacity test plan built
on it. **No load was generated. No server, Docker, nginx, LiveKit, kernel, DNS, firewall, SSH, Flutter or
backend file was modified.** Every number below was read from the running system on 2026-10-04.

The target questions (per listeners/room, rooms/VPS, total participants, bottlenecks, safe vs. hard capacity)
and the **targets to prove or disprove — ~3,000 listeners/room and ~10,000 total concurrent participants —
are treated as hypotheses, not capabilities.** Several audit findings already bound them (see §0 and §7).

---

## 0. Headline findings (what the audit already tells us)

Hard limits discovered that constrain the targets **before any test runs**:

| # | Finding | Evidence | Impact on targets |
|---|---------|----------|-------------------|
| F1 | **App caps a session at 300 participants** (`maxParticipantsPerSession` default 300, `moderatorReserve` 10; `LIVE_MAX_PARTICIPANTS_PER_SESSION` unset in staging) | `app-config.ts:294,298`; session view `participantCap:300` | 3,000/room via the **app path** needs a config change. Pure-SFU test must bypass the app. |
| F2 | **TURN relay range 30000–32767 ≈ ~590 concurrent relayed participants** | `compose.turn.yaml` (`LIVEKIT_TURN_RELAY_RANGE_*`) | TURN-relayed concurrency is hard-capped ~590. Direct-UDP clients are unaffected. |
| F3 | **nginx `worker_connections 768`**, `worker_processes auto` (18), no `worker_rlimit_nofile` | `/etc/nginx/nginx.conf` | ≈13.8k raw, but proxied WSS uses 2 FDs each → **~6–7k concurrent signalling/relay clients** — below 10k. |
| F4 | **Single NIC RX/TX queue** (`Combined: 1`) + **single UDP-mux media socket (7882)** | `ethtool -l eth0`; `livekit.yaml rtc.udp_port`; `ss` | WebRTC is high-PPS small-UDP; softirq concentrates on ~1 core → likely the **first media bottleneck**, well before 1 Gbps. |
| F5 | **No swap** (0 B) | `free`, `swapon` | RAM pressure = hard OOM-kill, no cushion. Keep large headroom. |
| F6 | **LiveKit exposes no Prometheus/metrics** (`prometheus_port` unset; `/metrics` → 404) | `livekit.yaml`; probe | Media metrics must come from the RoomService API + logs + host counters, or `prometheus_port` must be enabled (config change). |
| F7 | **Reconciler sweeps rooms matching the `live-staging-` prefix and removes foreign identities** | `live-reconciler-rooms.ts:98-143`, `live-reconciler-foreign.ts` | Pure-SFU load **must** use a non-app room prefix (e.g. `loadtest-`) and bypass the app, or the reconciler deletes rooms / kicks synthetic participants. |
| F8 | **No load-generation tooling installed** (no k6/artillery/autocannon/playwright/wrk/chromium/lk) | host probe | A generator must be built before any load runs. **But** `@livekit/rtc-node@1.1.0` is installed and a reusable headless client (`media-client.ts`) exists → media generator is a short build, not from scratch. |
| F9 | **No container resource limits**; **json-file logging without rotation** | `docker inspect`, `docker info` | No isolation between services; verbose logs under load can grow the disk unbounded. |

**Conclusion up front:** audio-only fan-out to thousands is plausible on this hardware; **screen-share
fan-out to thousands is network-bound and almost certainly infeasible** (§11); the 10k target is gated by
nginx `worker_connections` and by NIC-queue/softirq PPS, not by raw CPU or RAM. None of this is proven until
measured — but these are the hypotheses the ladder in §8 is designed to test cheaply and early.

---

## 1. Current architecture

Single VPS, `213.136.65.135` (`vmi3631989`), all tiers co-located:

```
                       Internet
                          │
        ┌─────────────────┼───────────────────────────────┐
        │ 443/tcp         │ 7882/udp  7881/tcp  3478/udp   │  (ufw: deny-by-default)
        ▼                 ▼           ▼         ▼
   nginx (host, 1.24.0)  ─── LiveKit SFU (container, HOST netns) ───
   stream{} L4:                 • ICE/UDP mux  :7882  (single socket)
   443 reuseport, ssl_preread   • ICE/TCP      :7881
   SNI→ 8443 (WSS/HTTPS)        • TURN/UDP     :3478
       └ 8444 (TURN/TLS)        • TURN/TLS     :5349 (via nginx only)
   http{} 8443 → TLS term →     • relay range  30000–32767/udp (local to SFU)
       api  127.0.0.1:3000      • signalling   7880 (loopback + 172.30.0.1 only)
       livekit 127.0.0.1:7880
        │
        ▼ (bridge institution_default 172.30.0.0/24)
   api (container, NestJS)  ──► db  (container, Postgres 16.15)
        │  └ /realtime (ws)  ──► redis (container, Redis 7.4.11)
```

- **nginx (host)** owns public 443: L4 `ssl_preread` demuxes SNI, forwards raw TLS over loopback with PROXY
  protocol to the HTTPS/WSS vhosts (8443) or the TURN/TLS terminator (8444→127.0.0.1:5349). **Every WSS
  signalling connection and every TURN/TLS-relayed stream traverses nginx.** TURN/UDP (3478) and ICE/UDP
  (7882) bypass nginx and hit LiveKit directly.
- **LiveKit (container, `network_mode: host`)** — media on the host namespace so embedded-TURN relay packets
  reach the SFU as NODE_IP↔NODE_IP by local delivery (the P7.3 fix for Firefox relays).
- **api / db / redis** — bridged, no published host ports except api's loopback `127.0.0.1:3000` (nginx reaches
  it). LiveKit control: api → `172.30.0.1:7880`.

---

## 2. Baseline measurements (idle, 2026-10-04 ~11:17 UTC)

| Component | CPU | Memory | Notes |
|-----------|-----|--------|-------|
| Host | load avg 0.6–1.0 / 18 vCPU | 2.0 GiB used / 94 GiB, **0 swap**, 92 GiB free | quiet |
| api (container) | 0.02% | 64 MiB | NestJS; (a 57% sample earlier was an in-container `node` audit exec, not steady state) |
| livekit | ~7.5% | 44 MiB | background stats loop; no rooms |
| redis | 0.4% | 7 MiB | 0 keys, 1 client |
| db | 0.06% | 38 MiB | 7/100 connections, DB 9.8 MiB |
| nginx | ~0% | ~9 MiB/worker × ~18 | 8 established conns on :443 |

Network error baseline (must stay ~flat under load): `/proc/net/snmp` Udp `InErrors=0 RcvbufErrors=0
SndbufErrors=0`; `/proc/net/softnet_stat` `dropped=0` on every CPU (cpu9 carries most net softirq). `nf_conntrack_count ≈ 75 / 262144`.

---

## 3. Hardware / resource inventory

**Host** — Ubuntu 24.04.5, kernel **6.8.0-146-generic**, KVM full-virt guest.
- **CPU:** AMD EPYC, **18 vCPU** (18 cores × 1 thread, 1 socket, single NUMA node, ~2.0 GHz base). No SMT.
- **RAM:** **94 GiB**, **no swap**.
- **Disk:** 581 GiB ext4 on `/dev/sda1`, **2% used** (~570 GiB free). overlayfs for Docker.
- **NIC:** `eth0` virtio, public `213.136.65.135/24` + IPv6; link speed not reported by the virtual NIC
  (nominal 1 Gbps per provider). **`Combined: 1` — a single RX/TX queue** (softirq processing pins to ~1 core).

**Kernel limits / sysctls (read-only; not to be changed in Phase 0):**

| Knob | Value | Relevance |
|------|-------|-----------|
| `fs.file-max` | effectively unbounded | ok |
| `ulimit -n` (soft/hard) | 1048576 / 1048576 | ok |
| `net.netfilter.nf_conntrack_max` | 262144 | UDP/NAT flows; ~10k participants fits, TURN adds flows |
| `net.core.somaxconn` | 4096 | accept backlog |
| `net.core.netdev_max_backlog` | **1000** | low; high-PPS ingress could drop (watch softnet `dropped`) |
| `net.ipv4.tcp_max_syn_backlog` | 4096 | |
| `net.ipv4.ip_local_port_range` | 32768–60999 (~28k) | client-side source ports; **overlaps nothing** with relay range (which sits 30000–32767, deliberately below) |
| `net.core.rmem_max` / `wmem_max` | 16 MiB / 16 MiB | raised above default — good for UDP bursts |
| `net.core.rmem_default` / `wmem_default` | 212992 | per-socket default |
| `net.ipv4.udp_mem` | 2310213 / 3080287 / 4620426 pages | generous |
| qdisc / cc | `fq_codel` / `cubic` | |

---

## 4. Existing load-generator capabilities

**Installed on host:** `node v22.23.3`, `npm 10.9.9`, `curl`, `jq`. **Not present:** k6, artillery,
autocannon, wrk, hey, vegeta, ab, Playwright, chromium/chrome, `lk`/`livekit-cli`.

**In the repo (reusable):**
- **`@livekit/rtc-node@1.1.0`** — installed in `backend/node_modules` (a devDependency; the real LiveKit
  WebRTC client with native bindings). Runs headless, no browser.
- **`backend/test/livekit/support/media-client.ts`** — a complete, tested headless participant built on
  rtc-node. It can:

| Capability | Supported by `media-client.ts` today | Notes |
|------------|--------------------------------------|-------|
| 1. Listener-only participant | ✅ `connect(ticket, subscribe=true)` | subscribe without publishing |
| 2. Audio publisher (speaker) | ✅ `publish('microphone')` | real 440 Hz Opus tone, 10 ms frames |
| 3. Screen-share publisher | ⚠️ `publish('screen_share')` | publishes a **64×64 blank** video — not bandwidth-representative; needs a realistic source for bandwidth tests |
| 4. Multiple rooms | ✅ (one `Room` per client; harness instantiates many) | |
| 5. TURN-relayed participant | ❓ **unverified** — `connect()` passes only `{autoSubscribe, dynacast}`; forcing `iceTransportPolicy:'relay'` via rtc-node `RoomOptions` must be confirmed | open question Q-P8-1 |
| 6. Reconnect storm | ⚠️ scriptable (connect/disconnect loops) but not a built-in | |
| Data/text channels | ✅ `sendData`/`sendText`/receive | for realtime-style payloads |

- **`ws` / `ioredis` / `pg` / `livekit-server-sdk`** are app deps → an API/realtime load script and direct
  LiveKit token minting can be written in Node with no new install.

**Verdict:** the **media** generator is a short build on `media-client.ts`; the **API/HTTP+WS** generator and
the **metrics collector** must be written (or k6 installed). No end-to-end load harness exists yet (F8).

---

## 5. Metrics available (read-only, no new tooling)

- **Host:** `/proc/stat` & `mpstat -P ALL` (per-core, incl. `%soft`), `free`, `/proc/net/dev` (RX/TX bytes &
  packets), `/proc/net/snmp` & `/proc/net/udp` (UDP errors), `/proc/net/softnet_stat` (drops/squeeze),
  `nf_conntrack_count`, `ss -s`, `/proc/loadavg`, `iostat`/`/proc/diskstats`.
- **Docker:** `docker stats` (per-container CPU/mem/pids/net/block).
- **LiveKit:** **RoomService API** (`ListRooms`, `ListParticipants` → per-participant tracks, mute state,
  and in logs `connectionType`/selected ICE candidate, `connectTime`, publish/subscribe events, packet/bitrate
  rtpStats on `participant active`/`grow bucket` lines); health endpoint (200 OK / 406 Not Ready). **No
  Prometheus.**
- **API:** `GET /health/ready` (uptime), `/health/live`; structured pino logs (request lines with `requestId`,
  latency derivable); realtime connection counts only via logs.
- **Postgres:** `pg_stat_activity` (connections/states), `pg_stat_database`, `pg_stat_bgwriter`,
  `pg_stat_statements` **available but not loaded**.
- **Redis:** `INFO` (clients, ops/sec, memory, rejected_connections, latency via `--latency`).
- **nginx:** error log (`worker_connections are not enough`, 502/504), `ss` on 443/8443/8444; **no stub_status
  endpoint configured.**

## 6. Missing metrics (gaps to close before/with testing)

1. **LiveKit Prometheus** (`prometheus_port`) — the single biggest gap for media capacity (per-room CPU, packet
   loss, forwarder stats, bandwidth). *Enabling it is a LiveKit config change → requires approval; until then
   rely on RoomService + log rtpStats + host counters.*
2. **nginx `stub_status`** — active/reading/writing/waiting connection gauge. Config change; otherwise infer
   from `ss`.
3. **Postgres `pg_stat_statements`** (loaded) and/or `log_min_duration_statement` — query latency. Config
   change + restart; otherwise coarse timing from app logs.
4. **Per-core softirq attribution** is available (`mpstat`), but there is **no continuous time-series store** —
   the collector (§20) must sample to CSV.
5. **Application realtime connection gauge** — only derivable from logs today.

---

## 7. Capacity hypotheses vs. discovered ceilings

| Target | Hypothesis | Ceiling already found | What must be true to reach it |
|--------|-----------|------------------------|-------------------------------|
| 3,000 listeners / room | TBD | App cap 300 (F1); SFU per-room cap = none configured | Raise `LIVE_MAX_PARTICIPANTS_PER_SESSION` for app-path; for SFU-path bypass app. Then PPS/softirq (F4) and audio fan-out bandwidth (§11) decide. |
| 10,000 total participants | TBD | nginx 768 conns (F3); realtime WS cap 10,000 (app code); NIC single queue (F4) | Raise nginx `worker_connections`+`worker_rlimit_nofile`; confirm softirq core headroom; audio-only bandwidth (~400 Mbps) fits 1 Gbps. |
| TURN-relayed at scale | TBD | ~590 relay ports (F2); TURN/TLS also via nginx CPU | Relay range is a deliberate small cap; >590 relayed needs a config change and more ephemeral space. |

---

## 8. Test ladder (staged, media plane)

Each rung runs only after the previous rung stays **green** on every §9 threshold for a sustained hold
(≥10 min) and recovers cleanly on teardown. **Stop climbing at the first rung that hits a WARNING threshold;
that locates the knee.** Numbers are starting points — adjust from measured headroom.

**Single room — 1 teacher (audio publisher) + N listeners (subscribe-only):**

| Rung | Listeners | Primary thing being measured |
|------|-----------|------------------------------|
| A | 10 | harness correctness, per-listener cost baseline |
| B | 100 | linear-cost assumption holds? |
| C | 500 | softirq core %, outbound Mbps |
| D | 1,000 | PPS, packet loss onset |
| E | 2,000 | approaching NIC-queue limit? |
| F | 3,000 | **target**: prove/disprove one-room 3k listeners |

**Multi-room — audio, 1 teacher + listeners each, total participants the variable:**

| Rung | Layout | Total | Purpose |
|------|--------|-------|---------|
| G | 5 × 500 | 2,500 | multi-room overhead vs. one big room |
| H | 10 × 500 | 5,000 | |
| I | 20 × 500 | 10,000 | **total target** (audio) |
| J | 50 × 200 | 10,000 | many-small-rooms shape (room bookkeeping cost) |

**Speaker / media-shape variants (hold total modest, vary media):**
- audio-only (baseline, above).
- 1 room, 1 speaker promoted among listeners (grant path) — forwarder fan-in cost.
- 1 room, 4 simultaneous speakers — 4×N downstream fan-out.
- **screen share:** 1 publisher + N subscribers, N small (50, 100, 250). *Expect network saturation early
  (§11); this rung is about finding where, not reaching thousands.* Needs a realistic video source first.
- multiple simultaneous screen shares (only if the architecture and §11 budget permit — likely 1–2 max).
- **TURN-relay rung:** repeat A–C with relay forced, **capped at ≤500 to stay under the ~590 relay-port
  ceiling** (F2); measures nginx TLS CPU for the 5349 path + relay overhead.
- **reconnect storm:** ramp to a green rung, then disconnect+reconnect 25–50% within ~10 s; measure
  re-signalling spike (nginx accepts, LiveKit renegotiation, token re-validation).
- **join/leave churn:** steady arrival/departure (e.g. 20/s) at a green occupancy; measures room bookkeeping
  and signalling churn.

---

## 9. Safety stop conditions (evidence-based hard stops)

Abort the current rung immediately (stop the generator) if **any** of these holds for >15 s. Thresholds are
tied to a specific failure mode, not round numbers:

| Signal | Threshold | Why this value |
|--------|-----------|----------------|
| **Hottest CPU core `%soft`+`%sys`** | > 85% sustained | F4: media is bottlenecked by single-queue softirq on ~1 core; aggregate CPU can look idle while one core caps. This is the expected media ceiling. |
| **Host load average (1 min)** | > 18 (= vCPU count) | run-queue exceeds cores → latency builds |
| **MemAvailable** | < 8 GiB | F5: no swap → the OOM killer is the only relief; 8 GiB leaves headroom for spikes |
| **OOM / dmesg** | any `Out of memory` / `oom-kill` | fatal; investigate before any further rung |
| **UDP `RcvbufErrors`/`InErrors`** (snmp delta) | any sustained increase | kernel dropping media at the socket = loss at the source |
| **softnet `dropped`** (per-cpu delta) | any sustained increase | NIC backlog (`netdev_max_backlog 1000`) overflow |
| **LiveKit-reported packet loss** (rtpStats) | > 2% sustained | media quality breakdown; audio artifacts |
| **Outbound bandwidth** (`/proc/net/dev` TX) | > 700 Mbps (~70% of 1 Gbps) | headroom for retransmits/bursts on a shared virtual NIC |
| **conntrack count** | > 209,000 (80% of 262144) | flow-table exhaustion drops new flows |
| **nginx error log** | `worker_connections are not enough` or 502/504 rate rising | F3: signalling-path saturation |
| **API `/health/ready`** | p99 > 1 s or non-200 rate > 1% | control plane degrading |
| **Postgres connections** | > 90 / 100 | max_connections exhaustion imminent |
| **Redis** | `rejected_connections` > 0, or `used_memory` climbing toward RAM | `maxmemory 0 noeviction` → writes fail rather than evict |
| **LiveKit health** | 406 Not Ready, or any container restart | SFU node stats stale/unhealthy |

---

## 10. Capacity definitions (to be filled by measurement)

- **SAFE** — sustainable indefinitely with headroom: hottest core `%soft+%sys` < 60%, MemAvailable > 16 GiB,
  outbound < 500 Mbps (50%), loss < 0.5%, zero UDP/softnet drops, API p99 < 300 ms. *The number quoted to
  operators.*
- **WARNING** — degradation beginning, operate only transiently: hottest core 60–85%, outbound 50–70%, loss
  0.5–2%, latency climbing. *Headroom band, not a run target.*
- **HARD** — maximum still-functional: any signal 85–95% / loss near 2%, no rejections yet. *Ceiling, never
  for production.*
- **FAILURE** — observed breakdown: loss > 5%, connections rejected, OOM, LiveKit 406/restart, media stops.
  *Record the exact participant count where each failure mode first appears.*

All four are **measured outputs** of the ladder, reported per scenario (listeners/room, rooms, total).

---

## 11. Bandwidth model (1 Gbps nominal)

1 Gbps = 125 MB/s theoretical; **realistic safe ceiling ≈ 700 Mbps (70%)** on a shared virtual NIC with a
single queue. The SFU forwards, so **outbound = Σ (per-stream bitrate × subscriber count)**:

| Media | Per-stream | 1 room, N subscribers | At N=3,000 | At 10,000 total |
|-------|-----------|------------------------|------------|-----------------|
| **Audio (Opus)** | ~20–40 kbps | 1 teacher → N × ~40 kbps | **~120 Mbps** | ~400 Mbps (audio) |
| **+ 4 speakers** | ~40 kbps ea | up to 4 × N × 40 kbps | ~480 Mbps | would exceed budget |
| **Screen share (observed 1080p VP8)** | **~1–2.5 Mbps** | N × ~2 Mbps | **~6 Gbps** ⇒ **6× over 1 Gbps** | infeasible |

**Implications:**
- **Audio-only is bandwidth-feasible** to the 3k/10k targets on 1 Gbps (the limiter will be PPS/softirq, F4,
  not raw bandwidth).
- **Screen-share fan-out is network-bound** and cannot reach thousands on 1 Gbps; simulcast/adaptive lowers
  per-subscriber bitrate but not enough. Screen tests exist to find the saturation point (low hundreds), not
  to reach the targets.
- **TURN-relayed** media is additionally capped at ~590 (F2); TURN/TLS also spends nginx CPU on the 5349 path.
- **Egress billing:** "1 Gbps / unlimited traffic" is a *rate*, not a capacity guarantee — sustained hundreds
  of Mbps for hours is large monthly egress; model cost separately, and never assume the virtual NIC delivers
  a full clean 1 Gbps of small UDP packets (PPS, not bps, is the real limit).

---

## 12. API-load plan (control + realtime, independent of media)

**Scope:** auth/login, session start, `/join` token issuance, admin, and the `/realtime` WebSocket — the HTTP
path through nginx→api→(pg,redis), with **no LiveKit media**.
- **Tool:** `k6` (install on an external host) **or** a Node script using `fetch` + `ws`. No browser needed.
- **Knobs observed:** realtime `maxConnections 10,000` (global), `connectionsPerUser 10`, auth deadline 10 s,
  heartbeat 25 s, `maxInboundFrameBytes 4096`, `maxBufferedBytes 1 MiB`. Rate limits (in-memory, per-instance,
  fixed-window): connect **300/60 s**, (action) **30/60 s**, frames **60/60 s**. Postgres `max_connections
  100`. Redis `maxclients 10000`.
- **Ladder:** (a) HTTP RPS ramp on `/health/ready` + `/auth/login` within rate limits; (b) `/realtime` WS
  connection ramp 100→1k→5k→**10k** (the app cap) watching nginx conns, api mem, redis; (c) token-mint
  throughput (`/live/sessions/:id/join`).
- **Measure:** RPS, p50/p95/p99 latency, error rate, api CPU/mem, nginx active conns, pg connections & state,
  redis ops/sec & clients.
- **Rate-limit note:** to exceed 300 connects/60 s legitimately, spread across many source identities/IPs, or
  test the limiter *as* the subject. Do not disable it.

## 13. LiveKit-load plan (media plane, independent of API)

**Isolation strategy (critical, from F7):** generate load **directly against the SFU, bypassing the app**:
1. Create rooms via `RoomServiceClient.createRoom` using the LiveKit API key — **with a non-app prefix, e.g.
   `loadtest-...`**, so the reconciler's prefix-scoped sweep never deletes them and foreign-identity
   enforcement never runs on them.
2. Mint participant tokens directly with `livekit-server-sdk` `AccessToken` (arbitrary identities, `roomJoin`
   + `canSubscribe`, `canPublish` only for speakers). **This writes nothing to Postgres** — zero app rows.
3. Drive participants with the rtc-node harness (built on `media-client.ts`).

This cleanly separates **SFU capacity** (this plan) from **app capacity** (§12) and sidesteps the 300 app cap
(F1) for raw SFU measurement. The app-path 3k/room (with the cap raised) is validated separately in the
combined phase.

- **Ladder:** §8 rungs A–J (audio), then speaker/screen/relay/reconnect/churn variants.
- **Measure (per rung):** RoomService participant/track counts; log rtpStats (bitrate, loss, jitter, nacks);
  host per-core `%soft`, TX Mbps, PPS, UDP/softnet drops, conntrack; livekit container CPU/mem.

## 14. Combined-load plan (realistic, last)

Only after §12 and §13 each have a known safe number: drive **app-issued** joins end-to-end (login → start →
`/join` → connect) at realistic teacher/listener ratios, through the full nginx→api→LiveKit path, at a fraction
(e.g. 50%) of the lower of the two independent safe numbers, then climb. This measures cross-tier contention
(nginx serving both WSS signalling and API; the box serving media + control on the same cores/NIC). Requires
`LIVE_MAX_PARTICIPANTS_PER_SESSION` raised if per-room > 300 is in scope (config change → approval).

**Recommended sequence (answers the critical design question): C then D — independent first, then combined.**
Order: **(1) API-load alone → (2) LiveKit media-load alone → (3) combined.** Media and API are tested
separately first (as expected), because co-located tiers share CPU/NIC and a combined-only test cannot
attribute a bottleneck. Within media, climb audio before screen before relay.

## 15. TURN test plan

- Repeat listener rungs **with relay forced**, capped **≤ 500** concurrent (F2: ~590 relay ports).
- Two relay transports: **TURN/UDP 3478** (direct to SFU) and **TURN/TLS 5349** (through nginx — measures
  nginx TLS CPU and the PROXY-protocol path). Compare per-participant CPU vs. direct UDP.
- **Blocker/Q-P8-1:** confirm rtc-node can force `iceTransportPolicy:'relay'`. If it cannot, the relay rung
  needs browser-based clients (the P7.4 local-file client already does this for small N) or a config approach.
- Watch relay-port exhaustion (allocations failing near ~590) and conntrack growth.

## 16. Reconnect / churn test plan

- **Reconnect storm:** reach a green rung, drop 25–50% of clients, reconnect within ~10 s. Measure the
  signalling spike: nginx accept rate, LiveKit ICE renegotiation, (combined phase) token re-validation on the
  app. Watch `netdev_max_backlog 1000` (softnet drops) and nginx `worker_connections`.
- **Join/leave churn:** steady arrivals+departures (e.g. 20/s) at a fixed occupancy; measures room bookkeeping
  and per-connection setup/teardown cost over time (memory growth, FD leaks).

## 17. Data cleanup strategy

- **Media-load (SFU-direct):** generates **zero app DB rows** (direct tokens, `loadtest-` rooms). Cleanup =
  `RoomServiceClient.deleteRoom` for each `loadtest-` room (or let `emptyTimeout` expire). Nothing in Postgres
  to undo.
- **API-load:** avoid per-iteration account creation (accounts are create→activate with no hard delete, and
  would pollute the DB — F-cleanup). Use a **small fixed pool of pre-seeded disposable test accounts**, reused
  across runs, or an isolated throwaway DB/schema for API-load. If rows are created, record their ids and
  disable/clean them in a teardown step. **Never use or notify real users** (there are none, but the rule
  stands).
- **Combined:** app sessions created during the run are ended (test 14 path) and are `live-staging-` rooms the
  reconciler will sweep; no manual room cleanup needed, but any created accounts follow the API-load rule.
- **Credentials** stay in the git-ignored, owner-only env file; load-gen tokens are ephemeral and never logged.

## 18. Expected artifacts / results

- Per-rung CSV time series (host per-core CPU/`%soft`, mem, TX Mbps, PPS, UDP/softnet drops, conntrack; docker
  stats; RoomService participant/track counts; redis/pg gauges; nginx conn counts).
- Per-rung LiveKit rtpStats extract (bitrate, loss, jitter) and a RoomService snapshot at steady state.
- A results table: scenario → (participants, outbound Mbps, hottest-core %, loss, verdict SAFE/WARN/HARD/FAIL).
- Graphs: participants vs. hottest-core %; participants vs. loss; participants vs. TX Mbps (with the 700 Mbps
  line). Final **SAFE / WARNING / HARD / FAILURE** capacity numbers per scenario, plus the named first
  bottleneck for each.
- A short record doc (`docs/p8-load-capacity-record.md`, later phase) mirroring the P7.4 record style.

## 19. Rollback / abort strategy

- **Phase 0 (now):** nothing to roll back — read-only.
- **During load (later):** the generator runs **off-box**; abort = **stop the generator** (kill switch). The
  staging box itself is not modified by a test, so recovery is: generator off → verify host counters return to
  baseline, `/health/ready` 200, LiveKit health OK, RoomService shows rooms draining. `loadtest-` rooms are
  deleted or expire.
- **If the box wedges:** the only on-box remedy is restarting a container (`docker restart <svc>`) — that is a
  change and is an **emergency-only** action, flagged, not a routine step.
- Any config change required to run a rung (nginx conns, participant cap, LiveKit prometheus, relay range) is a
  **separate, approved, reversible edit** recorded with its before/after and a revert command — never made
  silently inside a test.

## 20. Exact commands/scripts to be used later — **DO NOT EXECUTE NOW**

### 20.1 Read-only monitoring (safe; sampled to CSV by the collector)
```bash
# Per-core CPU incl. softirq (needs sysstat; otherwise parse /proc/stat)
mpstat -P ALL 2 1
# Memory, load
free -m ; cat /proc/loadavg
# NIC throughput + packets/sec (delta two reads of /proc/net/dev for eth0)
awk '/eth0:/{print $2,$3,$10,$11}' /proc/net/dev    # rxBytes rxPkts txBytes txPkts
# UDP socket errors (delta)
grep '^Udp:' /proc/net/snmp
# softirq backlog drops (delta, per cpu)
cat /proc/net/softnet_stat
# conntrack usage
cat /proc/sys/net/netfilter/nf_conntrack_count
# per-container
docker stats --no-stream
# LiveKit room/participant snapshot (RoomService, via api container env)
docker exec institution-api-1 sh -c 'cd /app && node --input-type=module -e "
 import {RoomServiceClient} from \"livekit-server-sdk\";
 const c=new RoomServiceClient(process.env.LIVEKIT_API_URL,process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);
 for (const r of await c.listRooms()) console.log(r.name, r.numParticipants);"'
# Redis / Postgres gauges
docker exec institution-redis-1 sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning info clients,stats,memory'
docker exec institution-db-1 psql -U institution -d institution -tAc "select state,count(*) from pg_stat_activity group by 1;"
```

### 20.2 Media load generator — **TO BE IMPLEMENTED (prerequisite)**
A Node CLI under `backend/test/load/` (or a standalone package) built on `@livekit/rtc-node` +
`media-client.ts`, run **from an external host**. Outline (not runnable yet):
```
inputs:  --url wss://livekit-staging.adlink4.com  --rooms R  --listeners N  --speakers S
         --screen 0|1  --relay 0|1  --ramp-per-sec K  --hold-seconds H  --prefix loadtest-
setup:   AccessToken (livekit-server-sdk) per participant; RoomServiceClient.createRoom(prefix+id)
run:     ramp K/s: MediaClient.connect(ticket, subscribe=true) for listeners;
         for speakers also .publish('microphone'); for screen .publish(<realistic video source>)
hold:    H seconds; sample nothing here (external collector does host/SFU metrics)
teardown: client.disconnect() all; RoomServiceClient.deleteRoom(each); dispose()
```
Gaps to close first: (a) confirm rtc-node relay-forcing (Q-P8-1); (b) a **realistic screen-share video source**
(not the 64×64 blank) for bandwidth-true screen tests; (c) the external host(s) to run it on.

### 20.3 API/realtime load — **TO BE IMPLEMENTED (prerequisite)**
`k6` script (install on external host) or Node `fetch`/`ws` script hitting `/auth/login`,
`/live/sessions/:id/join`, and `/realtime`. Ramps within rate limits; measures RPS/latency/errors.

---

## Blockers, prerequisites, and what must be built before any load runs

1. **Load generators do not exist (F8).** Build: (a) the rtc-node media harness (short, on `media-client.ts`),
   (b) an API/WS load script or k6. **STOP — this is the primary prerequisite.**
2. **External load-generation host(s)** with real bandwidth. Running the generator on the staging VPS would
   contend for the same cores/NIC and invalidate measurements (and only exercise loopback). Blocker.
3. **Q-P8-1:** verify `@livekit/rtc-node` can force TURN relay; else relay rung needs browser clients.
4. **Realistic screen-share video source** for bandwidth-true screen tests (current harness publishes 64×64).
5. **Config changes needed to exceed defaults — each a separate, approved, reversible edit, NOT part of
   Phase 0:** `LIVE_MAX_PARTICIPANTS_PER_SESSION` (app-path >300/room); nginx `worker_connections` +
   `worker_rlimit_nofile` (>~6–7k clients); LiveKit `prometheus_port` (real media metrics); TURN relay range
   (>~590 relayed); optionally nginx `stub_status`, `pg_stat_statements`, `net.core.netdev_max_backlog`.
6. **Metrics collector** (§20.1) to sample to CSV — to be written.
7. **json-file log rotation / caps** before long high-verbosity runs (F9) to protect the disk.

## Proposed exact P8 sequence

0. **(this doc)** Read-only audit + plan — **DONE, pending review.**
1. Build + unit-check the media harness and the metrics collector (off-box generator host provisioned).
2. **API-load alone** (§12) — establish API/PG/Redis/nginx-HTTP safe numbers.
3. **Media-load alone** (§13) — ladder A→F (one room), then G→J (multi-room), audio only; SFU-direct,
   `loadtest-` prefix. Locate the first bottleneck (expected: single-core softirq / PPS, F4).
4. Media variants: speakers, then **screen (expect early network saturation, §11)**, then **TURN relay
   (≤500)**, then reconnect/churn.
5. **Combined** (§14) at realistic ratios through the full path.
6. Record results (`docs/p8-load-capacity-record.md`), publish SAFE/WARNING/HARD/FAILURE capacities with named
   bottlenecks, and the evidence.

Any step that requires a config change (item 5 above) pauses for explicit approval with a before/after and a
revert command. **No load is run and no file outside this plan is changed without approval.**
