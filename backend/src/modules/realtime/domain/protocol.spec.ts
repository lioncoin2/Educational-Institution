import { parseClientFrame, REALTIME_ERROR_CODES } from './protocol';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2lnbmF0dXJl';

describe('the realtime protocol, as a client may speak it', () => {
  it('reads the three frames a client may send', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'auth', token: TOKEN }))).toEqual({
      ok: true,
      frame: { type: 'auth', token: TOKEN },
    });
    expect(
      parseClientFrame(JSON.stringify({ type: 'subscribe', conversationId: 'c-1', id: 'r1' })),
    ).toEqual({ ok: true, frame: { type: 'subscribe', conversationId: 'c-1', id: 'r1' } });
    expect(parseClientFrame(JSON.stringify({ type: 'ping', version: 1 }))).toEqual({
      ok: true,
      frame: { type: 'ping' },
    });
  });

  it.each([
    ['a binary frame', null],
    ['not JSON', '{type: auth'],
    ['a JSON array', '[{"type":"ping"}]'],
    ['a JSON string', '"ping"'],
    ['null', 'null'],
    ['an unknown type', '{"type":"broadcast"}'],
    ['no type', '{"token":"x"}'],
    ['a type from Object.prototype', '{"type":"toString"}'],
    ['another protocol version', '{"type":"ping","version":2}'],
  ])('refuses %s as INVALID_EVENT', (_what, text) => {
    const parsed = parseClientFrame(text);
    expect(parsed).toMatchObject({ ok: false, code: 'INVALID_EVENT' });
  });

  it.each([
    ['an auth frame without a token', { type: 'auth' }],
    ['a token that is not a string', { type: 'auth', token: 42 }],
    ['a token with characters no token has', { type: 'auth', token: 'a b<script>' }],
    ['an absurdly long token', { type: 'auth', token: 'a'.repeat(5000) }],
    ['a subscribe without a conversation', { type: 'subscribe' }],
    ['a conversation id that is not an id', { type: 'subscribe', conversationId: '../../etc' }],
    ['an over-long conversation id', { type: 'subscribe', conversationId: 'c'.repeat(65) }],
    ['a correlation id that is not one', { type: 'ping', id: 'has spaces' }],
  ])('refuses %s as INVALID_PAYLOAD', (_what, frame) => {
    expect(parseClientFrame(JSON.stringify(frame))).toMatchObject({
      ok: false,
      code: 'INVALID_PAYLOAD',
    });
  });

  // The server establishes who the caller is. A frame that tries to say it
  // is refused outright, not quietly ignored.
  it.each([
    ['a claimed user id', { type: 'auth', token: TOKEN, userId: 'someone-else' }],
    ['claimed roles', { type: 'auth', token: TOKEN, roles: ['OWNER'] }],
    ['claimed permissions', { type: 'auth', token: TOKEN, permissions: ['messaging.manage'] }],
    ['a claimed membership', { type: 'subscribe', conversationId: 'c-1', member: true }],
    ['a display name', { type: 'ping', displayName: 'Admin' }],
  ])('refuses a frame carrying %s', (_what, frame) => {
    expect(parseClientFrame(JSON.stringify(frame))).toMatchObject({
      ok: false,
      code: 'INVALID_PAYLOAD',
    });
  });

  it('echoes a valid correlation id on a refusal, so the client can match it', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'nope', id: 'req-7' }))).toEqual({
      ok: false,
      code: 'INVALID_EVENT',
      message: 'Unknown frame type.',
      id: 'req-7',
    });
  });

  it('names exactly the error codes the protocol documents', () => {
    expect([...REALTIME_ERROR_CODES]).toEqual([
      'UNAUTHORIZED',
      'FORBIDDEN',
      'INVALID_EVENT',
      'INVALID_PAYLOAD',
      'CONVERSATION_NOT_FOUND',
      'NOT_MEMBER',
      'RATE_LIMITED',
      'SERVER_ERROR',
    ]);
  });
});
