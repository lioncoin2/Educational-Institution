# Deployment

The API and the LiveKit media server, as two containers (P7.1). Everything
here is committed and holds no secret: each environment's values live in a
git-ignored `env/<environment>.env` made from its example. The full picture —
ports, TLS, TURN, the readiness check, and what was and was not verified — is
in [docs/p7-livekit-readiness.md](../docs/p7-livekit-readiness.md).

| File | What it is |
| --- | --- |
| [`compose.yaml`](compose.yaml) | the two services: `api`, built from [`backend/Dockerfile`](../backend/Dockerfile), and `livekit`, LiveKit v1.13.7 pinned by digest |
| [`compose.turn.yaml`](compose.turn.yaml) | LiveKit's embedded TURN, for staging and production |
| [`livekit/livekit.yaml`](livekit/livekit.yaml) | LiveKit's server policy, the same in every environment (`room.auto_create: false`) |
| [`env/<environment>.env.example`](env/) | each environment's contract: every variable, its secrets left empty |

## Bringing an environment up

Production, from the repository root (staging is the same with its own file):

```bash
cp infra/env/production.env.example infra/env/production.env   # git-ignored
# Set every secret (they ship empty: compose refuses to start until all are set)
# and replace every example value. Each secret:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

docker compose -f infra/compose.yaml -f infra/compose.turn.yaml \
  --env-file infra/env/production.env config --quiet            # the file is complete
(cd backend && npm ci && DATABASE_URL=… npm run db:migrate)      # from a checkout: the image never migrates
docker compose -f infra/compose.yaml -f infra/compose.turn.yaml \
  --env-file infra/env/production.env up -d --build
```

Development runs `compose.yaml` alone with `env/development.env`, no TURN:
clients on the same machine join LiveKit at `ws://localhost:7880`.

Each environment has its own LiveKit server, key, secret and hostnames:
nothing is shared between environments. The LiveKit secret also differs from
`JWT_SECRET` and `STORAGE_SIGNING_SECRET` — the API refuses to boot otherwise.
The LiveKit key and secret use letters, digits, `-` and `_` only: LiveKit
reads them as YAML.

## What the host provides

- **Postgres and Redis**, reachable from the `api` container at `DATABASE_URL`
  and `REDIS_URL`. They are not part of these files.
- **The existing TLS terminator.** It owns every certificate; this repository
  commits no configuration for it. What it must do, on public 443:

  | Hostname | Forwarded to |
  | --- | --- |
  | the API's (HTTPS, and the `/realtime` WebSocket) | `http://127.0.0.1:3000` |
  | `LIVEKIT_URL`'s (WebSocket signalling) | `http://127.0.0.1:7880` |
  | `LIVEKIT_TURN_DOMAIN` (TURN over TLS) | the decrypted stream, TCP, to `127.0.0.1:5349` |

- **Open to the internet:** 443 (the terminator), 7881/tcp and 7882/udp
  (media), 3478/udp (TURN). The loopback ports stay private. Nothing here
  changes a firewall.
- **`LIVEKIT_NODE_IP`:** the host's public IPv4, the address LiveKit gives
  clients for media.

## Good to know

- The API starts without LiveKit. Until LiveKit's `/rtc/validate` check
  passes — reachable, the key accepted, `auto_create` off — starting a session
  answers 503 and the logs say why (`live.provider.health_check`).
- The examples ship every secret empty and compose requires each, so nothing
  starts on a placeholder — LiveKit itself would start on any secret, only
  logging a short one. Generate each as shown above.
- Compose takes a variable from your shell before the environment file: start
  from a shell with no stray `LIVEKIT_*`, `JWT_*` or `NODE_ENV` exported.
- `livekit/livekit.yaml` must stay readable by others (mode 0644): the
  container runs with every capability dropped.
- CI validates every environment's compose files, and `npm test` in
  `backend/` includes the deployment tests (`backend/test/deployment/`).
