import type { NotificationTarget } from '../contracts/targets';
import { conversationIdOf, isPushMutedFor } from './conversation-mute';

describe('conversation mute', () => {
  const conversation: NotificationTarget = { kind: 'conversation', conversationId: 'c-1' };
  const otherConversation: NotificationTarget = { kind: 'conversation', conversationId: 'c-2' };
  const community: NotificationTarget = { kind: 'community', communityId: 'g-1' };
  const liveRoom: NotificationTarget = { kind: 'live_room', liveSessionId: 's-1' };
  const profile: NotificationTarget = { kind: 'profile' };

  describe('conversationIdOf', () => {
    it('reads the id from a conversation target', () => {
      expect(conversationIdOf(conversation)).toBe('c-1');
    });

    it('is null for every non-conversation target', () => {
      expect(conversationIdOf(community)).toBeNull();
      expect(conversationIdOf(liveRoom)).toBeNull();
      expect(conversationIdOf(profile)).toBeNull();
    });
  });

  describe('isPushMutedFor', () => {
    const muted = new Set(['c-1']);

    it('mutes exactly the muted conversation', () => {
      expect(isPushMutedFor(conversation, muted)).toBe(true);
      expect(isPushMutedFor(otherConversation, muted)).toBe(false);
    });

    it('never mutes a notification that is not conversation-scoped', () => {
      // A community-membership fact, a live room, a profile — none is a
      // conversation, so a conversation mute never changes their behaviour,
      // even if their own id happens to collide with a muted conversation id.
      expect(isPushMutedFor(community, muted)).toBe(false);
      expect(isPushMutedFor(liveRoom, muted)).toBe(false);
      expect(isPushMutedFor(profile, muted)).toBe(false);
      expect(isPushMutedFor({ kind: 'community', communityId: 'c-1' }, muted)).toBe(false);
    });

    it('mutes nothing when the muted set is empty', () => {
      expect(isPushMutedFor(conversation, new Set())).toBe(false);
    });
  });
});
