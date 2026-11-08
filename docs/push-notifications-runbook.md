# Push notifications — operations runbook (ADR 0058)

How real push (Firebase Cloud Messaging, Android) is switched on, checked, rolled back
and maintained. The design is in
[ADR 0058](architecture/decisions/0058-real-push-fcm-and-session-bound-devices.md) and
[notifications.md](architecture/notifications.md) §"Push". Nothing here is done without
the owner's go-ahead for the environment concerned.

## 1. What the institution provides

| Item | Where it goes | Never |
| --- | --- | --- |
| A Firebase project, with the Android app registered as `com.quraninstitution.quran_institution_app` | — | — |
| `google-services.json` for that app (identifies the project; not a secret, but kept out of git) | the build machine: `app/android/app/google-services.json` (git-ignored) | committed |
| A **dedicated** service account with the single role *Firebase Cloud Messaging API Admin* (`roles/firebasecloudmessaging.admin`) and one JSON key | the API host, §3 | the Firebase Admin SDK key, an Editor/Owner account, chat, e-mail, git, an image, an environment variable |
| The *Firebase Cloud Messaging API (V1)* enabled in the Google Cloud project | — | the legacy API |

The JSON key reaches the host by `scp` straight into `/root/push-setup/` (mode 0700),
never through a chat or a repository.

## 2. Order of a first rollout

1. Migration **0038** (`notification_devices.session_id`, nullable, plus an index) on the
   environment's database — before the new image; additive, so the running image is
   unaffected.
2. The new API image (it binds the session to each device; still logging-only).
3. The key on the host (§3) and the preflight (§4).
4. The push overlay (§5) — the API now sends.
5. Only then a push-enabled app build (§7) is distributed: an app that registers before
   the server can send just waits, but a server that sends with no app strings would
   show nothing useful.

## 3. Placing the key

The image runs as its `node` user (uid 1000). The file is owned by that uid, mode 0400, and
Docker bind-mounts it read-only. On this host uid 1000 is also the `ubuntu` login, so the file
lives in a root-only (0700) directory that user cannot enter — Docker mounts the file itself,
so the container still reads it:

```sh
install -d -m 0700 /etc/institution-push
install -o 1000 -g 1000 -m 0400 /root/push-setup/<key>.json /etc/institution-push/fcm-service-account.json
shred -u /root/push-setup/<key>.json
```

and in the environment file (`infra/env/<environment>.env`, or `trial.env`):

```sh
FCM_SERVICE_ACCOUNT_FILE=/etc/institution-push/fcm-service-account.json
```

## 4. Preflight — before the API depends on it

The smoke check sends nothing to anyone: FCM's `validate_only` checks the credentials,
the OAuth exchange, the project, the account's permission and the request's shape.
Run it with the image that is about to be deployed, as the same user, with the same
mount:

```sh
docker run --rm --user 1000:1000 --network bridge \
  -v /etc/institution-push/fcm-service-account.json:/run/secrets/fcm-service-account.json:ro \
  <api image> node dist/cli/push-smoke.js --credentials /run/secrets/fcm-service-account.json
```

Expected: `credentials: ok (project …)`, `fcm: invalid_token (INVALID_TOKEN)` and
`ok: credentials, project and permission accepted; the placeholder token was refused, as
it should be`. With a real phone's token (`--token-stdin`, the token on standard input —
never an argument), expect `fcm: delivered` and nothing shown on the phone.

| `not ok` reason | Meaning | Fix |
| --- | --- | --- |
| `PERMISSION_DENIED` | the account may not send, or the FCM API is disabled | grant *Firebase Cloud Messaging API Admin*; enable the FCM API (V1) |
| `NOT_FOUND` | no such project | the key belongs to another project |
| `oauth_http_400` | Google refused the signed assertion | a deleted/disabled key, or the host clock is wrong (`timedatectl`) |
| `oauth_http_401` | unknown service account | the account was deleted |
| `oauth_network` / `NETWORK` / `TIMEOUT` | Google unreachable from the host | outbound HTTPS to `oauth2.googleapis.com` and `fcm.googleapis.com` |
| credentials error at start | the file is unreadable or not a service-account key | owner uid 1000, mode 0400; the right file (the message names the field, never a value) |

## 5. Switching on, and back off

On:

```sh
# Trial
docker compose -p institution-trial -f infra/compose.trial.yaml \
  -f infra/compose.trial.environment.yaml [-f <image override>] \
  -f infra/compose.trial.push.yaml --env-file infra/env/trial.env up -d --no-deps trial-api
# Staging / production
docker compose -f infra/compose.yaml -f infra/compose.turn.yaml \
  -f infra/compose.push.yaml --env-file infra/env/<environment>.env up -d --no-deps api
```

The API reads the key once at startup; an unusable file stops the boot with a
`FcmCredentialsError` naming the problem (never the content). Check the container is
healthy and its log has no such error.

Off (rollback): the same command without the push overlay. `PUSH_PROVIDER` is then unset
and push is only logged; nothing else changes. Migration 0038 needs no rollback.

## 6. Running it

- **Key rotation** (yearly, or when someone with access leaves): create a new key for the
  same account, replace the file (§3), restart the API, run the preflight, then delete
  the old key in Google Cloud.
- **A leaked key:** delete it in Google Cloud first — sends then fail as `oauth_http_400`
  (rejected, logged, nothing retried) — then rotate.
- **What the log says:** each refusal no retry can mend is logged once per five minutes as
  *FCM refused a push and no retry will help*, with its reason (`SENDER_ID_MISMATCH`,
  `PERMISSION_DENIED`, `UNAUTHENTICATED`, `INVALID_ARGUMENT`, …). A device whose token is
  dead is switched off and audited (`notifications.device.disabled`); one whose session
  ended is forgotten and audited (`notifications.device.session_ended`). Logs and audit
  entries never hold a token, an access token or a key.
- **Play Console, Data safety:** the app collects a device identifier (the FCM
  registration token / Firebase installation ID) for app functionality — push — not
  shared with third parties for any other purpose.

## 7. The push-enabled app build

```sh
cp <google-services.json> app/android/app/google-services.json   # git-ignored
flutter build appbundle --release --dart-define=API_BASE_URL=… --dart-define=PUSH_ENABLED=true …
```

Without the file the Google services plugin is not applied and Firebase cannot start; without
the flag the app never asks for a token. Either way no token exists and nothing is shown — but
every Android build now links the Firebase plugins: their manifest entries are merged in
(`WAKE_LOCK`, `c2dm.permission.RECEIVE`, the FCM service and receiver), and with the file
present Firebase's own init provider starts it natively (auto-init stays off, so still no
token). iOS links the Firebase pods too; an iOS build is unverified here.

## 8. Acceptance on a phone

1. Phone A signs in and allows notifications; the app is swiped away.
2. B messages A → A's phone shows «رسالة جديدة» with no name and no text; a tap opens the
   conversation.
3. A signs out → B's next message reaches the inbox only, not A's phone.
4. An administrator ends A's sessions → nothing more reaches that phone.
5. With the app open, no system banner appears; the inbox and badge update live.

Some manufacturers' battery savers stop delivery to an app swiped away — known Android
behaviour, outside the server's reach.
