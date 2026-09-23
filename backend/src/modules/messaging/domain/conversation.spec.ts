import {
  directPairOf,
  newChannelConversation,
  newDirectConversation,
  newGroupConversation,
  normalizeTitle,
  type ConversationId,
} from './conversation';
import { MAX_PARTICIPANTS, TITLE_MAX_LENGTH } from './messaging-policy';

const AT = new Date('2026-09-01T08:00:00Z');
const id = 'c-1' as ConversationId;

describe('direct conversations', () => {
  // The pair is what the database keeps unique, so {A,B} and {B,A} must be one key.
  it('orders the pair, so both directions name the same conversation', () => {
    expect(directPairOf('b', 'a')).toEqual({ ok: true, value: { low: 'a', high: 'b' } });
    expect(directPairOf('a', 'b')).toEqual({ ok: true, value: { low: 'a', high: 'b' } });
  });

  it('refuses a conversation with oneself', () => {
    const result = newDirectConversation({ id, initiator: 'a', counterpart: 'a', at: AT });
    expect(!result.ok && result.error.code).toBe('messaging.direct_with_self');
  });

  it('has exactly two plain members, no title and no owner', () => {
    const result = newDirectConversation({ id, initiator: 'a', counterpart: 'b', at: AT });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.conversation).toMatchObject({
      type: 'DIRECT',
      title: null,
      memberCount: 2,
      lastSequence: 0,
      lastMessageAt: null,
    });
    expect(result.value.participants.map((p) => [p.userId, p.role])).toEqual([
      ['a', 'MEMBER'],
      ['b', 'MEMBER'],
    ]);
  });
});

describe('groups and channels', () => {
  it('makes the creator the owner, once, whatever the member list says', () => {
    const result = newGroupConversation({
      id,
      creator: 'owner',
      title: 'Halaqa',
      memberIds: ['s1', 'owner', 's2', 's1'],
      at: AT,
    });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.participants.map((p) => [p.userId, p.role])).toEqual([
      ['s1', 'MEMBER'],
      ['owner', 'OWNER'],
      ['s2', 'MEMBER'],
    ]);
    expect(result.value.conversation.memberCount).toBe(3);
  });

  it('gives named channel publishers the publisher role', () => {
    const result = newChannelConversation({
      id,
      creator: 'admin',
      title: 'Announcements',
      memberIds: ['s1', 't1'],
      publisherIds: ['t1'],
      at: AT,
    });
    if (!result.ok) throw new Error(result.error.code);
    const roles = Object.fromEntries(result.value.participants.map((p) => [p.userId, p.role]));
    expect(roles).toEqual({ admin: 'OWNER', s1: 'MEMBER', t1: 'PUBLISHER' });
  });

  it('refuses more members than the provisional cap', () => {
    const memberIds = Array.from({ length: MAX_PARTICIPANTS.GROUP }, (_, i) => `s${i}`);
    const result = newGroupConversation({ id, creator: 'owner', title: 'Big', memberIds, at: AT });
    expect(!result.ok && result.error.code).toBe('messaging.too_many_participants');
  });
});

describe('titles', () => {
  it('trims, collapses whitespace and removes control characters', () => {
    expect(normalizeTitle('  حلقة\n\tالفجر\u0000  ')).toEqual({ ok: true, value: 'حلقة الفجر' });
  });

  it('requires a title and bounds it', () => {
    expect(normalizeTitle('   ').ok).toBe(false);
    expect(normalizeTitle('x'.repeat(TITLE_MAX_LENGTH)).ok).toBe(true);
    expect(normalizeTitle('x'.repeat(TITLE_MAX_LENGTH + 1)).ok).toBe(false);
  });
});
