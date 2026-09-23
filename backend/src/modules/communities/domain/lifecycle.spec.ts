import { COMMUNITY_ACTS, type CommunityAct } from '../contracts/capabilities';
import { effectsOf, statePermits } from './lifecycle';

/**
 * Pins both views of the PROVISIONAL lifecycle table (§8.3). Changing what
 * LOCKED means edits this test and Q46 together.
 */
describe('the lifecycle (PROVISIONAL, Q46)', () => {
  it('states each status’s effects', () => {
    expect(effectsOf('OPEN')).toEqual({
      acceptsMembers: true,
      chatReadable: true,
      chatPostingOpen: true,
      liveStartOpen: true,
      liveJoinOpen: true,
      runningLiveContinues: true,
    });
    expect(effectsOf('LOCKED')).toEqual({
      acceptsMembers: false,
      chatReadable: true,
      chatPostingOpen: false,
      liveStartOpen: false,
      liveJoinOpen: true,
      runningLiveContinues: true,
    });
    // A status a later build added: every new action closed, nobody ejected.
    expect(effectsOf('ARCHIVED')).toEqual({
      acceptsMembers: false,
      chatReadable: false,
      chatPostingOpen: false,
      liveStartOpen: false,
      liveJoinOpen: false,
      runningLiveContinues: true,
    });
  });

  it('permits each act per status exactly as the design states', () => {
    const row = (act: CommunityAct) =>
      ['OPEN', 'LOCKED', 'ARCHIVED']
        .map((status) => (statePermits(status, act) ? 'T' : 'F'))
        .join('');
    expect(Object.fromEntries(COMMUNITY_ACTS.map((act) => [act, row(act)]))).toEqual({
      'community.view': 'TTT',
      'community.members.view': 'TTT',
      'community.members.remove': 'TTT',
      'community.lock': 'TTT',
      'community.members.invite': 'TFF',
      'community.chat.post': 'TFF',
      'community.live.start': 'TFF',
      'community.chat.read': 'TTF',
      'community.live.join': 'TTF',
      'community.live.raise_hand': 'TTF',
      'community.live.moderate': 'TTT',
      'community.live.host': 'TTT',
    });
  });

  it('never blocks community.lock', () => {
    for (const status of ['OPEN', 'LOCKED', 'ARCHIVED', '']) {
      expect(statePermits(status, 'community.lock')).toBe(true);
    }
  });
});
