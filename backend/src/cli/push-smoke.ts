import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { FcmPushProvider } from '../modules/notifications/infrastructure/fcm/fcm-push-provider';
import { readServiceAccountFile } from '../modules/notifications/infrastructure/fcm/fcm-credentials';
import { pushMessageFor } from '../modules/notifications/domain/push';
import { SystemClock } from '../platform/primitives/system-clock';
import { asId } from '../shared';

/**
 * Checks a deployment's FCM setup without sending anything to anyone (ADR 0058
 * runbook): the credentials file, the OAuth exchange, the project, the service
 * account's permission and the request's shape, by one `validate_only` send.
 *
 *   node dist/cli/push-smoke.js [--credentials /run/secrets/fcm-service-account.json]
 *   node dist/cli/push-smoke.js --token-stdin < token.txt    # a real phone's token
 *
 * With no token, a placeholder is checked and FCM is expected to refuse IT —
 * which it only gets to after accepting the credentials, the project and the
 * permission. With a real token (read from standard input, never an argument),
 * FCM is expected to accept the push; `validate_only` means nothing is shown.
 *
 * Prints reasons — canonical codes — and never a key, token or access token.
 * Exit code 0 when the answer is the expected one.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      credentials: { type: 'string' },
      'token-stdin': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const path = values.credentials ?? process.env.FCM_CREDENTIALS_FILE ?? '';
  if (path === '') {
    process.stderr.write('usage: push-smoke [--credentials <file>] [--token-stdin]\n');
    process.exitCode = 2;
    return;
  }
  const realToken = values['token-stdin'] ? await firstLine(process.stdin) : null;
  if (values['token-stdin'] && (realToken === null || realToken.trim() === '')) {
    process.stderr.write('No token received on standard input.\n');
    process.exitCode = 2;
    return;
  }

  const credentials = readServiceAccountFile(path);
  process.stdout.write(`credentials: ok (project ${credentials.projectId})\n`);
  const provider = FcmPushProvider.fromCredentials(credentials, new SystemClock());
  const outcome = await provider.validate(
    {
      id: 'smoke-check',
      platform: 'ANDROID',
      provider: 'FCM',
      token: realToken?.trim() ?? PLACEHOLDER_TOKEN,
    },
    pushMessageFor({
      id: asId<'Notification'>('smoke-check'),
      recipientUserId: 'smoke-check',
      type: 'MESSAGE_RECEIVED',
      category: 'MESSAGES',
      titleKey: 'notification.message_received.title',
      bodyKey: 'notification.message_received.body',
      params: {},
      target: { kind: 'conversation', conversationId: 'smoke-check' },
      dedupeKey: 'smoke-check',
      createdAt: new Date(),
      readAt: null,
    }),
  );
  const reason = 'reason' in outcome ? ` (${outcome.reason})` : '';
  process.stdout.write(`fcm: ${outcome.kind}${reason}\n`);

  const expected =
    realToken === null ? outcome.kind === 'invalid_token' : outcome.kind === 'delivered';
  if (expected) {
    process.stdout.write(
      realToken === null
        ? 'ok: credentials, project and permission accepted; the placeholder token was refused, as it should be\n'
        : 'ok: FCM accepts a push to this device\n',
    );
    return;
  }
  process.stdout.write(
    `not ok: ${HINTS[outcome.kind === 'delivered' ? '' : outcome.reason] ?? 'see the push runbook (ADR 0058)'}\n`,
  );
  process.exitCode = 1;
}

/** Shaped like a registration token, and certainly nobody's. */
const PLACEHOLDER_TOKEN = `smoke-check-placeholder:${'A'.repeat(140)}`;

const HINTS: Readonly<Record<string, string>> = {
  PERMISSION_DENIED:
    'the service account may not send — grant it the Firebase Cloud Messaging API Admin role, and enable the FCM API',
  NOT_FOUND: 'no such Firebase project — check the credentials file is this project’s',
  UNAUTHENTICATED: 'Google refused the access token — the key may be disabled or deleted',
  oauth_http_400:
    'Google refused the signed assertion — a deleted key, or this server’s clock is wrong',
  oauth_http_401: 'Google does not know this service account',
  oauth_network: 'Google’s token endpoint cannot be reached from here',
  NETWORK: 'FCM cannot be reached from here',
  TIMEOUT: 'FCM did not answer in time',
};

function firstLine(input: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise((resolve) => {
    const lines = createInterface({ input, terminal: false });
    let settled = false;
    lines.once('line', (line) => {
      settled = true;
      lines.close();
      resolve(line);
    });
    lines.once('close', () => {
      if (!settled) resolve(null);
    });
  });
}

main().catch((error: unknown) => {
  // A credentials problem names the field, never a value (FcmCredentialsError).
  process.stderr.write(`${error instanceof Error ? error.message : 'push smoke check failed'}\n`);
  process.exitCode = 1;
});
