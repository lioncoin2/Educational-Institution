import { baseAccountOf, isIssuedParticipantIdentity, isLiveId } from './live-ids';

/** An account id as identity issues one: a lower-case uuid. */
const ACCOUNT = '0b7f3e52-6c1d-4f4e-9a57-3d2c1b0a9f88';

/** Every identity the application issues, and the edges of the shape. */
const ISSUED: ReadonlyArray<readonly [string, string]> = [
  ['an account id', ACCOUNT],
  ['an account id in capitals', ACCOUNT.toUpperCase()],
  ['a test account id', 'teacher-1'],
  ['one character', 'a'],
  ['every kind of character the shape allows', 'aZ09:_-'],
  ['128 characters', 'x'.repeat(128)],
];

/**
 * What a client can make of a publishing token (LiveKit v1.13.7 appends
 * `#<publish>`, SRV `pkg/service/utils.go:378-387`), and every other string
 * that is not an id.
 */
const REFUSED: ReadonlyArray<readonly [string, string]> = [
  ['an account id and a suffix', `${ACCOUNT}#mic`],
  ['an account id and an empty suffix', `${ACCOUNT}#`],
  ['an account id suffixed with another', `${ACCOUNT}#${ACCOUNT}`],
  ['an account id and two suffixes', `${ACCOUNT}#a#b`],
  ['a lone #', '#'],
  ['a suffix alone', `#${ACCOUNT}`],
  ['nothing', ''],
  ['129 characters', 'x'.repeat(129)],
  ['a space', 'teacher 1'],
  ['a line break', 'teacher-1\n'],
  ['a dot', 'teacher.1'],
  ['a slash', 'teacher/1'],
  ['an @', 'teacher@1'],
  ['letters beyond ASCII', 'مدرس'],
  ['a NUL', 'teacher-1\u0000'],
];

describe('media identities (the identity contract, P7.1)', () => {
  it.each(ISSUED)('accepts %s: the account id is the one identity issued', (_, identity) => {
    expect(isIssuedParticipantIdentity(identity)).toBe(true);
  });

  it.each(REFUSED)('refuses %s: no identity the application issues', (_, identity) => {
    expect(isIssuedParticipantIdentity(identity)).toBe(false);
  });

  it('is the id shape itself — one definition, whatever it is asked about', () => {
    for (const [, sample] of [...ISSUED, ...REFUSED]) {
      expect(isIssuedParticipantIdentity(sample)).toBe(isLiveId(sample));
    }
  });

  describe('the account named in a refused identity — for logs only', () => {
    it('is the part before the first `#`, when that part is an id', () => {
      expect(baseAccountOf(`${ACCOUNT}#mic`)).toBe(ACCOUNT);
      expect(baseAccountOf(`${ACCOUNT}#`)).toBe(ACCOUNT);
      expect(baseAccountOf(`${ACCOUNT}#a#b`)).toBe(ACCOUNT);
      expect(baseAccountOf(`teacher-1#${'x'.repeat(4_000)}`)).toBe('teacher-1');
    });

    it.each([
      ['a suffix alone', `#${ACCOUNT}`],
      ['a lone #', '#'],
      ['nothing', ''],
      ['a base with a space', 'teacher 1#mic'],
      ['a base of 129 characters', `${'x'.repeat(129)}#mic`],
      ['129 characters and no #', 'x'.repeat(129)],
      ['a dot and no #', 'teacher.1'],
      ['a base beyond ASCII', 'مدرس#1'],
    ])('is null for %s: nothing a client chose is ever returned', (_, identity) => {
      expect(baseAccountOf(identity)).toBeNull();
    });

    it('names only the account whose token was used, of every refused identity', () => {
      const named = REFUSED.map(([, identity]) => baseAccountOf(identity)).filter(
        (base) => base !== null,
      );
      expect(named).toEqual([ACCOUNT, ACCOUNT, ACCOUNT, ACCOUNT]);
    });
  });
});
