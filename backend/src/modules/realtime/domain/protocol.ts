/**
 * The realtime wire protocol, version 1 — the vocabulary both ends speak.
 *
 * One JSON object per WebSocket text frame. Every frame the server sends
 * carries `type` and `version`; a client frame may carry `version` (it must
 * then be 1) and an `id` of its own choosing, which the server echoes on its
 * reply so a client can match the two.
 *
 * Client → server:
 *   auth       { token }            first frame, and again with a fresh token
 *                                   before the current one expires
 *   subscribe  { conversationId }   confirm one conversation; answered with
 *                                   its positions, or an error
 *   ping       {}                   answered with `pong`
 *
 * Server → client:
 *   ready                 authenticated (again): who, until when
 *   subscribed            a conversation's positions, to catch up from
 *   pong
 *   error                 { code, message } — codes below, never a stack trace
 *   conversation.created  the reader is in a conversation just created
 *   message.sent          a new message
 *   message.read          the reader's own read mark moved (their other devices)
 *   participant.added     the reader was added to a conversation
 *   participant.removed   the reader was removed from, or left, a conversation
 *
 * Nothing here knows a socket library. See docs/architecture/realtime.md.
 */
export const PROTOCOL_VERSION = 1;

/** The path the WebSocket endpoint is served on, next to the HTTP API. */
export const REALTIME_PATH = '/realtime';

export const REALTIME_ERROR_CODES = [
  /** Not authenticated, or no longer: a bad, expired or revoked credential. */
  'UNAUTHORIZED',
  /** Authenticated, but the account may not do this. */
  'FORBIDDEN',
  /** Not a frame of this protocol: not JSON, binary, an unknown type or version. */
  'INVALID_EVENT',
  /** A known frame with missing, extra or malformed fields. */
  'INVALID_PAYLOAD',
  /** No such conversation — or not one the caller may see; the two are indistinguishable. */
  'CONVERSATION_NOT_FOUND',
  /**
   * Reserved. V1 answers any non-member, former members included, with
   * CONVERSATION_NOT_FOUND, so a guessed id cannot confirm that a conversation
   * exists. Clients treat the two alike.
   */
  'NOT_MEMBER',
  /** Too many frames, connections or authentications; `retryAfterSeconds` says how long to wait. */
  'RATE_LIMITED',
  /** Something failed on the server. Nothing about it is disclosed. */
  'SERVER_ERROR',
] as const;

export type RealtimeErrorCode = (typeof REALTIME_ERROR_CODES)[number];

/**
 * WebSocket close codes this server uses. 4000–4999 are reserved for
 * applications (RFC 6455 §7.4.2); the last three digits echo the HTTP status
 * with the same meaning, so they read at a glance.
 */
export const CloseCodes = Object.freeze({
  /** The server is shutting down: reconnect with backoff. */
  goingAway: 1001,
  /** A frame over the size limit (sent by the transport). */
  messageTooBig: 1009,
  /** An unexpected failure. */
  serverError: 1011,
  /** The client fell too far behind: reconnect, then catch up over HTTP. */
  tryAgainLater: 1013,
  /** Not a frame of this protocol, repeatedly. */
  protocolError: 4400,
  /** Authenticate again: refresh the access token, then reconnect. */
  unauthorized: 4401,
  /** The account may not use realtime messaging. Retrying will not help. */
  forbidden: 4403,
  /** Too many connections, frames or authentications: back off. */
  rateLimited: 4429,
});

/** A client's correlation id: short, and nothing that needs escaping. */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Conversation ids are opaque, bounded and URL-safe. */
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An access token as the HTTP API accepts one (RFC 6750 b64token), bounded. */
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const MAX_TOKEN_LENGTH = 4096;

export type ClientFrame =
  | { readonly type: 'auth'; readonly id?: string; readonly token: string }
  | { readonly type: 'subscribe'; readonly id?: string; readonly conversationId: string }
  | { readonly type: 'ping'; readonly id?: string };

export type ParsedFrame =
  | { readonly ok: true; readonly frame: ClientFrame }
  | {
      readonly ok: false;
      readonly code: Extract<RealtimeErrorCode, 'INVALID_EVENT' | 'INVALID_PAYLOAD'>;
      readonly message: string;
      /** The client's id, when the frame got far enough to carry a valid one. */
      readonly id?: string;
    };

const FIELDS: Readonly<Record<ClientFrame['type'], readonly string[]>> = {
  auth: ['type', 'version', 'id', 'token'],
  subscribe: ['type', 'version', 'id', 'conversationId'],
  ping: ['type', 'version', 'id'],
};

const invalidEvent = (message: string, id?: string): ParsedFrame => ({
  ok: false,
  code: 'INVALID_EVENT',
  message,
  ...(id === undefined ? {} : { id }),
});

const invalidPayload = (message: string, id?: string): ParsedFrame => ({
  ok: false,
  code: 'INVALID_PAYLOAD',
  message,
  ...(id === undefined ? {} : { id }),
});

/**
 * Reads one client frame. `null` stands for a binary frame, which this
 * protocol does not have. Strict, like the HTTP API: an unknown field is a
 * refusal, not something to ignore.
 */
export function parseClientFrame(text: string | null): ParsedFrame {
  if (text === null) return invalidEvent('Only JSON text frames are accepted.');

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidEvent('A frame must be one JSON object.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidEvent('A frame must be one JSON object.');
  }
  const frame = value as Record<string, unknown>;

  let id: string | undefined;
  if (frame.id !== undefined) {
    if (typeof frame.id !== 'string' || !REQUEST_ID.test(frame.id)) {
      return invalidPayload('id must be 1–64 characters of A–Z, a–z, 0–9, _ or -.');
    }
    id = frame.id;
  }
  if (frame.version !== undefined && frame.version !== PROTOCOL_VERSION) {
    return invalidEvent(`This server speaks protocol version ${PROTOCOL_VERSION}.`, id);
  }
  const type = frame.type;
  if (typeof type !== 'string' || !Object.hasOwn(FIELDS, type)) {
    return invalidEvent('Unknown frame type.', id);
  }
  const allowed = FIELDS[type as ClientFrame['type']];
  const extra = Object.keys(frame).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    return invalidPayload(`Unexpected field: ${String(extra[0]).slice(0, 32)}.`, id);
  }

  switch (type as ClientFrame['type']) {
    case 'auth': {
      const token = frame.token;
      if (
        typeof token !== 'string' ||
        token.length === 0 ||
        token.length > MAX_TOKEN_LENGTH ||
        !ACCESS_TOKEN.test(token)
      ) {
        return invalidPayload('auth needs an access token.', id);
      }
      return { ok: true, frame: { type: 'auth', token, ...(id === undefined ? {} : { id }) } };
    }
    case 'subscribe': {
      const conversationId = frame.conversationId;
      if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) {
        return invalidPayload('subscribe needs a conversationId.', id);
      }
      return {
        ok: true,
        frame: { type: 'subscribe', conversationId, ...(id === undefined ? {} : { id }) },
      };
    }
    case 'ping':
      return { ok: true, frame: { type: 'ping', ...(id === undefined ? {} : { id }) } };
  }
}
