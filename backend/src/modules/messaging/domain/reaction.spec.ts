import { MESSAGE_REACTIONS, isMessageReaction } from './reaction';

describe('message reactions (domain)', () => {
  it('accepts every curated emoji', () => {
    for (const emoji of MESSAGE_REACTIONS) {
      expect(isMessageReaction(emoji)).toBe(true);
    }
  });

  it('rejects anything outside the set, and non-strings', () => {
    expect(isMessageReaction('🍕')).toBe(false);
    expect(isMessageReaction('')).toBe(false);
    expect(isMessageReaction('👍 ')).toBe(false);
    expect(isMessageReaction(undefined)).toBe(false);
    expect(isMessageReaction(42)).toBe(false);
  });
});
