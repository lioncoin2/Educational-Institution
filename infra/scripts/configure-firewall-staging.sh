#!/usr/bin/env bash
# Configure the host firewall (ufw) for the P7.3 staging deployment.
#
# SSH (22) is allowed FIRST and explicitly, before enabling, so enabling ufw
# cannot lock anyone out. SSH authentication policy is NOT touched (out of scope).
#
# Public (internet-facing):
#   22/tcp    SSH
#   80/tcp    ACME HTTP-01 + redirect (nginx)
#   443/tcp   HTTPS / WSS / TURN-over-TLS (nginx, SNI-demuxed)
#   7881/tcp  LiveKit ICE/TCP media fallback
#   7882/udp  LiveKit ICE/UDP muxed media
#   3478/udp  LiveKit embedded TURN over UDP
#
# Deliberately NOT public (owner decision 2026-10-03, matching design §2/§6):
#   30000-32767/udp  TURN relay range — its only peer is the local SFU, reached
#                    over loopback; opening it adds surface for no function.
#   3000 (API), 5432 (Postgres), 6379 (Redis)  — loopback / bridge only.
#   7880 (LiveKit signalling), 5349 (TURN/TLS)  — loopback / gateway only.
#
# Internal: the bridged API reaches the host-networked LiveKit's signalling port
# at the fixed bridge gateway 172.30.0.1:7880; that packet hits the host INPUT
# chain, so it is allowed explicitly for the bridge subnet only.
set -euo pipefail

echo "== ruleset BEFORE =="
ufw status verbose || true

# SSH first — never lock out.
ufw allow 22/tcp comment 'SSH'

# Public service ports.
ufw allow 80/tcp   comment 'nginx ACME/redirect'
ufw allow 443/tcp  comment 'nginx HTTPS/WSS/TURN-TLS'
ufw allow 7881/tcp comment 'LiveKit ICE/TCP'
ufw allow 7882/udp comment 'LiveKit ICE/UDP'
ufw allow 3478/udp comment 'LiveKit TURN/UDP'

# Internal: API (bridge) -> LiveKit (host) signalling over the gateway.
ufw allow from 172.30.0.0/24 to any port 7880 proto tcp comment 'API->LiveKit control'

# Default deny incoming, allow outgoing (does not touch the outbound control path).
ufw default deny incoming
ufw default allow outgoing

ufw --force enable

echo "== ruleset AFTER =="
ufw status verbose
