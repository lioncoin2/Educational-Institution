import { sourcesOf, type RtcCapabilities, type RtcSource } from './rtc-provider';
import { capabilityDrift, capabilitiesFor, roleOf, type ParticipantStanding } from './standing';

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
          canPublishScreen: standing.presenter && standing.publishesByRight,
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

  it('gives the presenter the screen, never its audio — only while they hold live.speak', () => {
    const presenter = { ...NOBODY, moderator: true, publishesByRight: true, presenter: true };
    expect(capabilitiesFor(presenter)).toEqual({
      ...LISTENS_ONLY,
      canPublishAudio: true,
      canPublishScreen: true,
    });
    // A moderator who lost live.speak, still holding the slot: no screen
    // (P6 decision 1) — and no microphone by right either.
    expect(capabilitiesFor({ ...presenter, publishesByRight: false })).toEqual(LISTENS_ONLY);
    expect(capabilitiesFor({ ...NOBODY, presenter: true })).toEqual(LISTENS_ONLY);
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

describe('capabilityDrift — observed against desired (audit D22)', () => {
  const SPEAKS: RtcCapabilities = { ...LISTENS_ONLY, canPublishAudio: true };
  const held = (capabilities: RtcCapabilities, publishing: RtcSource[] = []) => ({
    capabilities,
    publishing,
  });

  it('is none when every field is equal and nothing is published beyond the set', () => {
    expect(capabilityDrift(held(LISTENS_ONLY), LISTENS_ONLY)).toBe('none');
    expect(capabilityDrift(held(SPEAKS, ['microphone']), SPEAKS)).toBe('none');
  });

  it('exceeds for every publish right, and `hidden`, held beyond the set', () => {
    for (const field of [
      'canPublishAudio',
      'canPublishScreen',
      'canPublishScreenAudio',
      'canPublishData',
      'hidden',
    ] as const) {
      expect({
        field,
        drift: capabilityDrift(held({ ...LISTENS_ONLY, [field]: true }), LISTENS_ONLY),
      }).toEqual({
        field,
        drift: 'exceeds',
      });
    }
  });

  it('exceeds for a source published that the set does not allow, whatever the flags say', () => {
    expect(capabilityDrift(held(LISTENS_ONLY, ['microphone']), LISTENS_ONLY)).toBe('exceeds');
    expect(capabilityDrift(held(SPEAKS, ['screen_share']), SPEAKS)).toBe('exceeds');
  });

  it('is below — never exceeds — for a right not yet applied, or any other difference', () => {
    expect(capabilityDrift(held(LISTENS_ONLY), SPEAKS)).toBe('below');
    expect(capabilityDrift(held({ ...LISTENS_ONLY, canSubscribe: false }), LISTENS_ONLY)).toBe(
      'below',
    );
  });

  it('is exceeds when one right is missing and another held beyond the set', () => {
    const screenInsteadOfMicrophone = { ...LISTENS_ONLY, canPublishScreen: true };
    expect(capabilityDrift(held(screenInsteadOfMicrophone), SPEAKS)).toBe('exceeds');
  });
});
