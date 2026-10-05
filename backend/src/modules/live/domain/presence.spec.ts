import { normalizePresence } from './presence';
import type { RtcCapabilities, RtcParticipantObservation } from './rtc-provider';

const CAPS: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

function obs(
  overrides: Pick<RtcParticipantObservation, 'identity'> & Partial<RtcParticipantObservation>,
): RtcParticipantObservation {
  return {
    state: 'active',
    standard: true,
    joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    publishing: [],
    capabilities: CAPS,
    ...overrides,
  };
}

describe('normalizePresence — provider_registry_v1 (attendance.md §5.2, live.md §22)', () => {
  it('maps an active standard account to a connected entry', () => {
    expect(normalizePresence([obs({ identity: 'user-1', state: 'active' })])).toEqual([
      { userId: 'user-1', connection: 'connected' },
    ]);
  });

  it('maps joining and joined to connecting', () => {
    expect(
      normalizePresence([
        obs({ identity: 'user-1', state: 'joining' }),
        obs({ identity: 'user-2', state: 'joined' }),
      ]),
    ).toEqual([
      { userId: 'user-1', connection: 'connecting' },
      { userId: 'user-2', connection: 'connecting' },
    ]);
  });

  it('drops non-standard participants (ingress, egress, SIP, agent, recorder)', () => {
    expect(normalizePresence([obs({ identity: 'egress-1', standard: false })])).toEqual([]);
  });

  it('drops an identity that is not account-shaped (unmappable)', () => {
    expect(normalizePresence([obs({ identity: 'not an account id' })])).toEqual([]);
  });

  it('drops a client-chosen #-suffixed identity (the publish trick)', () => {
    expect(normalizePresence([obs({ identity: 'user-1#publish' })])).toEqual([]);
  });

  it('keeps a hidden participant — hidden is a display grant, not a connection fact', () => {
    const hidden = obs({ identity: 'user-1', capabilities: { ...CAPS, hidden: true } });
    expect(normalizePresence([hidden])).toEqual([{ userId: 'user-1', connection: 'connected' }]);
  });

  it('collapses duplicates to one entry per account, CONNECTED winning in either order', () => {
    const connectingFirst = normalizePresence([
      obs({ identity: 'user-1', state: 'joining' }),
      obs({ identity: 'user-1', state: 'active' }),
    ]);
    const connectedFirst = normalizePresence([
      obs({ identity: 'user-1', state: 'active' }),
      obs({ identity: 'user-1', state: 'joined' }),
    ]);
    expect(connectingFirst).toEqual([{ userId: 'user-1', connection: 'connected' }]);
    expect(connectedFirst).toEqual([{ userId: 'user-1', connection: 'connected' }]);
  });

  it('orders entries ascending by account id, whatever order they arrive', () => {
    const result = normalizePresence([
      obs({ identity: 'user-3' }),
      obs({ identity: 'user-1' }),
      obs({ identity: 'user-2', state: 'joining' }),
    ]);
    expect(result.map((entry) => entry.userId)).toEqual(['user-1', 'user-2', 'user-3']);
  });

  it('leaks no provider metadata — only userId and connection', () => {
    const [entry] = normalizePresence([
      obs({
        identity: 'user-1',
        joinedAt: new Date('2020-01-01T00:00:00.000Z'),
        publishing: ['microphone'],
      }),
    ]);
    expect(Object.keys(entry ?? {}).sort()).toEqual(['connection', 'userId']);
  });

  it('returns an empty list for an empty observation', () => {
    expect(normalizePresence([])).toEqual([]);
  });
});
