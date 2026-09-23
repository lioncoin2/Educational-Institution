import type { ConversationId } from './ids';
import { canManageMembers, canPost, canSee, newParticipant } from './participant';

const AT = new Date('2026-09-01T08:00:00Z');
const conversation = (type: 'DIRECT' | 'GROUP' | 'CHANNEL', lastSequence: number) => ({
  id: 'c-1' as ConversationId,
  type,
  lastSequence,
});

describe('joining', () => {
  // Q21: a group's earlier messages were written to a smaller audience.
  it('hides a group history from before the join', () => {
    const joined = newParticipant(conversation('GROUP', 40), 'u', 'MEMBER', 'owner', AT);
    expect(joined.hiddenThroughSequence).toBe(40);
    expect(canSee(joined, 40)).toBe(false);
    expect(canSee(joined, 41)).toBe(true);
  });

  it('shows a channel its whole history — a notice board', () => {
    const joined = newParticipant(conversation('CHANNEL', 40), 'u', 'MEMBER', 'owner', AT);
    expect(joined.hiddenThroughSequence).toBe(0);
    expect(canSee(joined, 1)).toBe(true);
  });

  // Joining a channel with 500 notices must not greet anyone with "500 unread".
  it('counts everything that already exists as read', () => {
    for (const type of ['GROUP', 'CHANNEL'] as const) {
      const joined = newParticipant(conversation(type, 500), 'u', 'MEMBER', 'owner', AT);
      expect(joined.lastReadSequence).toBe(500);
      // The read-state invariant: hidden ≤ read.
      expect(joined.hiddenThroughSequence).toBeLessThanOrEqual(joined.lastReadSequence);
    }
  });
});

describe('roles', () => {
  it('lets only the owner and publishers post in a channel; everyone posts elsewhere', () => {
    expect(canPost('CHANNEL', 'MEMBER')).toBe(false);
    expect(canPost('CHANNEL', 'PUBLISHER')).toBe(true);
    expect(canPost('CHANNEL', 'OWNER')).toBe(true);
    expect(canPost('GROUP', 'MEMBER')).toBe(true);
    expect(canPost('DIRECT', 'MEMBER')).toBe(true);
  });

  it("lets only an owner manage members, and nobody a DM's", () => {
    expect(canManageMembers('GROUP', 'OWNER')).toBe(true);
    expect(canManageMembers('GROUP', 'MEMBER')).toBe(false);
    expect(canManageMembers('CHANNEL', 'PUBLISHER')).toBe(false);
    expect(canManageMembers('DIRECT', 'OWNER')).toBe(false);
  });
});
