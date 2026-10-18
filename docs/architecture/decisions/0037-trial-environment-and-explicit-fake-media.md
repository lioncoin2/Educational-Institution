# 0037 — The Trial is a deployed environment: full security baseline, media declared explicitly

**Status:** Proposed — 2026-10-18 (engineering remediation; applies when the owner approves the
remediation patch and the Trial redeploy). Amends the environment model of P7.1 decision 2
(`app-config.ts` `isDeployed`) and the media-provider binding of the P6 audit D19
(`live.module.ts` `rtcProviderFor`). Supersedes nothing; every other ADR is unchanged.

**Acceptance blocker (reviewed 2026-10-18, left Proposed):** the engineering content was re-checked
against the code and tests and holds; acceptance is nevertheless the owner's, because the decision
changes the deployment contract of an internet-facing environment and lets it run live sessions
that carry no media. It is to be accepted together with the Trial redeploy decision (D-8 in
[`trial-remediation-2026-10.md`](../../trial-remediation-2026-10.md)), and the code that
implements it is not to be merged while this record is Proposed.

## Context

The internet-facing web Trial (`https://trial.adlink4.com`, isolated compose project
`institution-trial`) runs the API with `NODE_ENV=development`. That was chosen because it was the
only way to get the in-process **fake** media provider (no LiveKit server exists for the Trial), but
`development` also switches off every production-grade configuration check: a missing
`JWT_SECRET`/`STORAGE_SIGNING_SECRET` silently becomes the published development default, a
placeholder or a short secret is accepted, the two secrets may be equal, and `DATABASE_URL` may be
missing (the modules then run in memory). A non-revealing check on 2026-10-17 found the Trial's two
secrets present, 54 bytes, non-placeholder and distinct — correct by luck of configuration, not by
any guard.

`NODE_ENV=staging` is not the answer: a deployed environment demands a LiveKit server (URL, key,
secret, `wss:`), refuses the development secret that binds the fake, and so binds the *disabled*
provider — live sessions could no longer start at all. The Trial also sat behind nginx without
`TRUST_PROXY`, so every client had the proxy's address and every per-IP rate limit (sign-in 30 per
5 minutes, refresh, password change) was one limit shared by every user of the Trial.

## Decision

1. **A fifth environment, `trial`, which is deployed.** `isDeployed` is true for `trial`, `staging`
   and `production`. The Trial therefore gets exactly staging's baseline: every secret required,
   no placeholder, at least 32 bytes, kept apart; `DATABASE_URL` and `REDIS_URL` required (no local
   default, no silent in-memory fallback); a default log level of `info`.
2. **The fake media provider is a declared choice: `LIVE_MEDIA_PROVIDER=fake`.** Sessions start and
   end, no media flows, and the boot line says so (`media provider: fake (LIVE_MEDIA_PROVIDER=fake)`).
   A deployment that declares the fake runs no media server, so no LiveKit setting is demanded of
   it. **Production refuses the fake** at boot: real people would join sessions with no sound and
   nothing to say so. Unset still means what it meant (the fake only for the development secret,
   otherwise the provider that refuses every call); `livekit` is unchanged.
3. **`TRUST_PROXY` is named in every deployed environment** (`false` included), and a value that is
   not `true`, `false` or a number of hops is refused everywhere instead of being read as `false`.

The decision changes no product behaviour: the Trial keeps fake media and its data. Staging
already sets `TRUST_PROXY` and `LIVE_MEDIA_PROVIDER=livekit` (verified on the running staging
container: its variable names and these two non-secret values only); production has no running
deployment, and its committed contract `infra/env/production.env.example` sets both.

## Consequences

- The Trial's environment must change at its next deploy: `NODE_ENV=trial`,
  `LIVE_MEDIA_PROVIDER=fake`, `TRUST_PROXY=1` (one nginx hop). With the new image and the *old*
  environment the API still boots — as `development`, unprotected — so the deployment changes the
  image and the environment in one step, and its post-deploy check confirms the boot line and
  `NODE_ENV=trial`. With `NODE_ENV=trial` but no `LIVE_MEDIA_PROVIDER=fake`, it refuses to boot
  (no LiveKit settings): a misconfiguration fails closed.
- A future Trial that wants real media sets `LIVE_MEDIA_PROVIDER=livekit` and gets every LiveKit
  requirement, exactly as staging.
- `NodeEnv` gains a member; the only consumers are configuration and the LiveKit readiness probe,
  both covered by tests. Error responses under `NODE_ENV=trial` were checked to stay the standard
  JSON envelope (no framework error page).
- The Trial's three settings ship as `infra/compose.trial.environment.yaml`, layered on the
  Trial's compose file rather than editing it.
- Only production refuses the fake: staging may declare it. That is deliberate (staging may need
  to run without its media server); the owner may tighten it to "trial only".
- With the fake declared, the frozen configuration still carries LiveKit's development defaults
  (`devkey`, the development secret). They are unused — the declared fake binds first, and only
  LiveKit-specific code reads them — but they are not cleared.

## Alternatives

- **`NODE_ENV=staging` + the fake.** Rejected: "staging" would then name two different
  environments in logs, refusals and runbooks, and the fake would still need an explicit choice.
- **A separate `SECURITY_PROFILE` variable beside `NODE_ENV=development`.** Rejected: two variables
  that must agree are a misconfiguration waiting to happen; the environment already is the profile.
- **Real LiveKit for the Trial.** Not chosen here: an infrastructure and owner decision (GROUP F,
  capacity and TURN gates) outside this remediation.

## Verification

`src/platform/config/app-config.spec.ts` (the trial describe block: missing, whitespace, placeholder,
short, byte-counted and duplicated secrets; required database, Redis and proxy; the fake refused in
production; an unknown environment), `livekit-config.spec.ts` (trial among the deployed environments),
`src/modules/live/live.module.spec.ts` (the fake bound for a declared trial, never from the
development secret there, refused in production).
