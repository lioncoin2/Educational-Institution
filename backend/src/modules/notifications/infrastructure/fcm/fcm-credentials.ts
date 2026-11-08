import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Google's OAuth 2.0 token endpoint — the only one a service account may name. */
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/**
 * What the FCM adapter needs of a Firebase service account (ADR 0058): which
 * project it sends for, who it signs as, and the signing key — held as a
 * KeyObject, so the PEM text is not kept around once parsed.
 */
export interface FcmCredentials {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKeyId: string;
  readonly privateKey: KeyObject;
}

/**
 * A credentials file that cannot be used. Its message names what is wrong and
 * never a value from the file: the file holds a private key, and a boot error
 * is printed to the deployment's log.
 */
export class FcmCredentialsError extends Error {
  constructor(problem: string) {
    super(`FCM credentials: ${problem}`);
    this.name = 'FcmCredentialsError';
  }
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SERVICE_ACCOUNT_EMAIL =
  /^[a-z0-9][a-z0-9-]{4,62}@[a-z0-9][a-z0-9-]{4,62}\.iam\.gserviceaccount\.com$/;
const PRIVATE_KEY_ID = /^[0-9a-f]{40}$/;

/** The service-account JSON, checked field by field. */
export function parseServiceAccount(text: string): FcmCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Deliberately not the parser's message: it quotes the text it choked on.
    throw new FcmCredentialsError('the file is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FcmCredentialsError('the file is not a JSON object');
  }
  const account = parsed as Record<string, unknown>;
  const field = (name: string): string => {
    const value = account[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new FcmCredentialsError(`"${name}" is missing`);
    }
    return value;
  };
  if (field('type') !== 'service_account') {
    throw new FcmCredentialsError('"type" is not "service_account"');
  }
  const projectId = field('project_id');
  if (!PROJECT_ID.test(projectId)) {
    throw new FcmCredentialsError('"project_id" is not a Google Cloud project id');
  }
  const clientEmail = field('client_email');
  if (!SERVICE_ACCOUNT_EMAIL.test(clientEmail)) {
    throw new FcmCredentialsError('"client_email" is not a service account');
  }
  const privateKeyId = field('private_key_id');
  if (!PRIVATE_KEY_ID.test(privateKeyId)) {
    throw new FcmCredentialsError('"private_key_id" is not a key id');
  }
  // Absent in some exports; when present it must be Google's, or the signed
  // assertion would be handed to someone else.
  if (account.token_uri !== undefined && account.token_uri !== GOOGLE_TOKEN_URI) {
    throw new FcmCredentialsError(`"token_uri" is not ${GOOGLE_TOKEN_URI}`);
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: field('private_key'), format: 'pem' });
  } catch {
    throw new FcmCredentialsError('"private_key" is not a PEM private key');
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw new FcmCredentialsError('"private_key" is not an RSA key');
  }
  return Object.freeze({ projectId, clientEmail, privateKeyId, privateKey });
}

/**
 * Reads the mounted file once, at startup. Its path is not repeated in the
 * error: a key pasted where the path belongs would otherwise be printed.
 */
export function readServiceAccountFile(path: string): FcmCredentials {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';
    throw new FcmCredentialsError(`the credentials file cannot be read (${code})`);
  }
  return parseServiceAccount(text);
}
