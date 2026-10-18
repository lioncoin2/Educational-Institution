# Trial harness — run the app against a real backend

Toward a usable **trial release**: exercise the Flutter app against the real API
(not the demo/mock repositories) on a developer machine. Physical-device testing
is deliberately out of scope here — this is the **web** app against a real,
Postgres-backed backend on localhost. Nothing here uses production or staging
secrets; it generates its own throwaway values and never reads `infra/env/*.env`.

## One-time / each session

```bash
scripts/trial/local-backend.sh up       # throwaway Postgres (Docker) + migrate + bootstrap owner
scripts/trial/local-backend.sh serve     # run the API on :3100 (Ctrl-C to stop)
```

In another shell, point the Flutter web app at it:

```bash
cd app && flutter run -d chrome --dart-define=API_BASE_URL=http://localhost:3100
# (add --dart-define=LIVE_MEDIA_ENABLED=true only when testing live audio)
```

Sign in with the owner the bootstrap created (`owner@institution.test` /
`Owner-Trial-Pass-9x7q` by default — override with `OWNER_EMAIL` / `OWNER_PASSWORD`).

Tear down when done:

```bash
scripts/trial/local-backend.sh down      # removes the throwaway Postgres + local secrets
```

## What is proven

The trial's core journey is a **permanent integration test**,
`backend/test/integration/academic-journey-postgres.spec.ts`, which drives the
real backend over HTTP exactly as the Flutter repositories do and asserts every
response carries the exact JSON keys / enum values the Flutter models parse. It
runs in CI (the backend job's `npm run verify`, with a Postgres service and
`TEST_DATABASE_URL`), and locally against the throwaway Postgres:

```bash
scripts/trial/local-backend.sh up         # start Postgres (if not already up)
scripts/trial/local-backend.sh smoke       # runs the Jest journey spec against it
# or directly:
cd backend && TEST_DATABASE_URL=postgresql://institution:devpw@127.0.0.1:5433/institution \
  npx jest test/integration/academic-journey-postgres.spec.ts --runInBand
```

Journey: owner login → create section → program → halaqa → provision + role +
activate a TEACHER account → provision + role + activate a STUDENT account →
assign the teacher to the halaqa → enrol the student → the teacher logs in and
sees the halaqa under `GET /academic/me` `teaching[]` → the teacher reads the
halaqa roster and sees the student. This confirms the designed
identity → academic → teacher chain is connected end to end against a real
server, and that the client contract holds at runtime (not only in source). The
spec creates and drops its own isolated scratch database per run; it never uses
an existing server or shared data.

## Building the web client artifact for the trial

A trial artifact points the Flutter **web** build at a real backend. The endpoint
is a compile-time define, so it is configured **per environment** through a
committed, secret-free file (mirroring `infra/env/*.env.example`) rather than
ad-hoc flags — reproducible and reviewable:

```bash
cd app
cp config/trial.env.example config/trial.env     # git-ignored; set API_BASE_URL
flutter build web --release --no-web-resources-cdn \
  --dart-define-from-file=config/trial.env
# artifact: app/build/web  (serve it behind TLS; set the backend's CORS_ORIGINS
# to this web origin, which also governs the /realtime WebSocket)
```

`config/trial.env` holds **only** an address and feature flags — never a secret.
The client embeds no JWT / storage / LiveKit secret and no database URL; its only
credentials are the short-lived tokens it receives at sign-in. A server secret
must never be passed as a `--dart-define`: it would be baked into the published
artifact. (Verified: a backend-mode build bakes `API_BASE_URL` and contains none
of `JWT_SECRET`, `STORAGE_SIGNING_SECRET`, `LIVEKIT_API_SECRET`, `DATABASE_URL`,
`REDIS_URL`.)

This is **build** configuration only. Where the artifact is hosted, and the
installable **release format** (web vs an Android APK vs an iOS build + Apple
signing), are owner decisions — see `docs/owner-decision-register.md`. The
existing GitHub Pages workflow (`deploy-pages.yml`) stays the mock-only demo and
is intentionally left untouched.

## Notes / limits

- **Connection is not attendance.** Joining a live session never records
  presence (ADR 0020/0023; Q68 open). Nothing here changes that.
- Live media (LiveKit) stays a separate readiness track; the dev backend binds
  the `fake` media provider unless a real LiveKit is configured.
- The scripts here are a manual/dev convenience for running the **app** against
  a real backend; the journey's *contract* is owned by the Jest integration spec
  above (the single maintained source of truth, enforced in CI).
