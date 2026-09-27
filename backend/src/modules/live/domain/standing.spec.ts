import { sourcesOf, type RtcCapabilities } from './rtc-provider';
import { capabilitiesFor, roleOf, type ParticipantStanding } from './standing';

const NOBODY: ParticipantStanding = {
  moderator: false,
  publishesByRight: false,
  speakerGrant: false,
  presenter: false,
};

/** Every one of the sixteen standings. */
const EVERY_STANDING: readonly ParticipantStanding[] = [false, true].flatMap((moderator) =>
  [false, true].flatMap((publishesByRight) =>
    [false, true].flatMap((speakerGrant) =>
      [false, true].map((presenter) => ({ moderator, publishesByRight, speakerGrant, presenter })),
    ),
  ),
);

const LISTENS_ONLY: RtcCapabilities = {
  canPublishAudio: false,
  canPublishScreen: false,
  canPublishScreenAudio: false,
  canSubscribe: true,
  canPublishData: false,
  hidden: false,
};

describe('capabilitiesFor — the capability matrix', () => {
  it('covers every standing, stating every field every time', () => {
    expect(EVERY_STANDING).toHaveLength(16);
    for (const standing of EVERY_STANDING) {
      const capabilities = capabilitiesFor(standing);
      expect(Object.keys(capabilities).sort()).toEqual(Object.keys(LISTENS_ONLY).sort());
      expect({ standing, capabilities }).toEqual({
        standing,
        capabilities: {
          canPublishAudio: standing.speakerGrant || standing.publishesByRight,
          canPublishScreen: standing.presenter,
          canPublishScreenAudio: false,
          canSubscribe: true,
          canPublishData: false,
          hidden: false,
        },
      });
    }
  });

  it('lets a listener publish nothing — not even data', () => {
    expect(capabilitiesFor(NOBODY)).toEqual(LISTENS_ONLY);
    expect(sourcesOf(capabilitiesFor(NOBODY))).toEqual([]);
  });

  it('gives a granted hand the microphone, and only the microphone', () => {
    expect(capabilitiesFor({ ...NOBODY, speakerGrant: true })).toEqual({
      ...LISTENS_ONLY,
      canPublishAudio: true,
    });
  });

  it('gives a moderator without live.speak no microphone', () => {
    expect(capabilitiesFor({ ...NOBODY, moderator: true })).toEqual(LISTENS_ONLY);
    expect(capabilitiesFor({ ...NOBODY, moderator: true, publishesByRight: true })).toEqual({
      ...LISTENS_ONLY,
      canPublishAudio: true,
    });
  });

  it('gives the presenter the screen, never its audio', () => {
    expect(capabilitiesFor({ ...NOBODY, presenter: true })).toEqual({
      ...LISTENS_ONLY,
      canPublishScreen: true,
    });
    expect(
      sourcesOf(
        capabilitiesFor({
          moderator: true,
          publishesByRight: true,
          speakerGrant: true,
          presenter: true,
        }),
      ),
    ).toEqual(['microphone', 'screen_share']);
  });

  it('maps no standing to the camera, the data channel, screen audio or hiding', () => {
    for (const standing of EVERY_STANDING) {
      const capabilities = capabilitiesFor(standing);
      expect(sourcesOf(capabilities).every((source) => source !== 'screen_share_audio')).toBe(true);
      expect(
        sourcesOf(capabilities).every((source) => ['microphone', 'screen_share'].includes(source)),
      ).toBe(true);
      expect(capabilities).toMatchObject({
        canPublishData: false,
        canPublishScreenAudio: false,
        hidden: false,
        canSubscribe: true,
      });
    }
  });
});

describe('roleOf', () => {
  it('shows moderator over speaker over listener', () => {
    for (const standing of EVERY_STANDING) {
      const expected = standing.moderator
        ? 'moderator'
        : standing.speakerGrant
          ? 'speaker'
          : 'listener';
      expect({ standing, role: roleOf(standing) }).toEqual({ standing, role: expected });
    }
    // A moderator who also holds a granted hand is still shown as a moderator.
    expect(roleOf({ ...NOBODY, moderator: true, speakerGrant: true })).toBe('moderator');
    // The presenter slot is a grant, not a role.
    expect(roleOf({ ...NOBODY, presenter: true })).toBe('listener');
  });
});
