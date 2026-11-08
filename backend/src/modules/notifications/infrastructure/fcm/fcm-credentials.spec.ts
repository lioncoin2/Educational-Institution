import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TEST_CLIENT_EMAIL,
  TEST_PRIVATE_KEY_ID,
  TEST_PRIVATE_KEY_PEM,
  TEST_PROJECT_ID,
  serviceAccountJson,
} from '../../../../../test/support/fcm-fixtures';
import {
  FcmCredentialsError,
  parseServiceAccount,
  readServiceAccountFile,
} from './fcm-credentials';

describe('FCM service-account credentials', () => {
  it('reads a service account, holding the key as an RSA key object', () => {
    const credentials = parseServiceAccount(serviceAccountJson());
    expect(credentials).toMatchObject({
      projectId: TEST_PROJECT_ID,
      clientEmail: TEST_CLIENT_EMAIL,
      privateKeyId: TEST_PRIVATE_KEY_ID,
    });
    expect(credentials.privateKey.type).toBe('private');
    expect(credentials.privateKey.asymmetricKeyType).toBe('rsa');
    expect(JSON.stringify(credentials)).not.toContain('PRIVATE KEY');
  });

  it('accepts an export that names no token endpoint', () => {
    expect(parseServiceAccount(serviceAccountJson({ token_uri: undefined })).projectId).toBe(
      TEST_PROJECT_ID,
    );
  });

  it('refuses text that is not JSON — without quoting any of it', () => {
    const broken = serviceAccountJson().slice(0, -2);
    const error = captured(() => parseServiceAccount(broken));
    expect(error).toBeInstanceOf(FcmCredentialsError);
    expect(error.message).toBe('FCM credentials: the file is not valid JSON');
    expect(error.message).not.toContain('PRIVATE');
  });

  it.each([
    ['not an object', '[]', 'not a JSON object'],
    ['another kind of account', serviceAccountJson({ type: 'authorized_user' }), '"type"'],
    ['no project', serviceAccountJson({ project_id: undefined }), '"project_id" is missing'],
    ['a malformed project', serviceAccountJson({ project_id: 'Not A Project' }), '"project_id"'],
    [
      'a person, not a service account',
      serviceAccountJson({ client_email: 'ali@gmail.com' }),
      '"client_email"',
    ],
    ['a malformed key id', serviceAccountJson({ private_key_id: 'xyz' }), '"private_key_id"'],
    [
      'a token endpoint that is not Google’s',
      serviceAccountJson({ token_uri: 'https://evil.example/token' }),
      '"token_uri"',
    ],
    ['a key that is not PEM', serviceAccountJson({ private_key: 'not a key' }), '"private_key"'],
  ])('refuses %s', (_case, text, problem) => {
    const error = captured(() => parseServiceAccount(text));
    expect(error).toBeInstanceOf(FcmCredentialsError);
    expect(error.message).toContain(problem);
    expect(error.message).not.toContain('BEGIN');
  });

  it('refuses a key that is not RSA — RS256 is what Google verifies', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(
      captured(() => parseServiceAccount(serviceAccountJson({ private_key: ec }))).message,
    ).toBe('FCM credentials: "private_key" is not an RSA key');
  });

  it('reads the mounted file once, and says why it could not — never what is in it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcm-credentials-'));
    const path = join(dir, 'service-account.json');
    writeFileSync(path, serviceAccountJson(), { mode: 0o400 });
    expect(readServiceAccountFile(path).projectId).toBe(TEST_PROJECT_ID);

    const missing = captured(() => readServiceAccountFile(join(dir, 'absent.json')));
    expect(missing.message).toBe('FCM credentials: the credentials file cannot be read (ENOENT)');
    // A key pasted where the path belongs is not printed back.
    const pasted = captured(() => readServiceAccountFile(serviceAccountJson()));
    expect(pasted.message).not.toContain('PRIVATE KEY');
    expect(pasted.message).not.toContain('service_account');

    const garbled = join(dir, 'garbled.json');
    writeFileSync(garbled, `{"private_key": "${TEST_PRIVATE_KEY_PEM.slice(0, 60)}`);
    expect(captured(() => readServiceAccountFile(garbled)).message).not.toContain('BEGIN');
  });
});

function captured(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected an error');
}
