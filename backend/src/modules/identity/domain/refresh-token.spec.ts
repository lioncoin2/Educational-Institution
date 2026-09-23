import { formatRefreshToken, parseRefreshToken } from './refresh-token';

const SECRET = 'A'.repeat(43);
const SESSION = '3f2b1c4d-0000-4000-8000-000000000001';

describe('refresh token format', () => {
  it('round-trips a session id and secret', () => {
    expect(parseRefreshToken(formatRefreshToken(SESSION, SECRET))).toEqual({
      sessionId: SESSION,
      secret: SECRET,
    });
  });

  it.each([
    ['empty', ''],
    ['no separator', `${SESSION}${SECRET}`],
    ['two separators', `${SESSION}.${SECRET}.x`],
    ['empty session', `.${SECRET}`],
    ['short secret', `${SESSION}.${'A'.repeat(42)}`],
    ['long secret', `${SESSION}.${'A'.repeat(44)}`],
    ['bad secret alphabet', `${SESSION}.${'+'.repeat(43)}`],
    ['bad session alphabet', `se$$ion.${SECRET}`],
    ['sql in session', `x' OR 1=1 --.${SECRET}`],
  ])('rejects %s', (_label, token) => {
    expect(parseRefreshToken(token)).toBeNull();
  });
});
