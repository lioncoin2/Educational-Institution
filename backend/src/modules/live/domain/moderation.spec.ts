import { AUDIT_ACTION_BY_MODERATION, MODERATION_ACTION_TYPES } from './moderation';

describe('moderation actions', () => {
  it('knows the ten types of live.md §3.5', () => {
    expect([...MODERATION_ACTION_TYPES].sort()).toEqual(
      [
        'start_session',
        'end_session',
        'grant_speaker',
        'decline_speaker',
        'revoke_speaker',
        'grant_presenter',
        'revoke_presenter',
        'reset_media',
        'mute_participant',
        'remove_participant',
      ].sort(),
    );
  });

  it('audits each type under its own action — one each, never shared (plan §2.3)', () => {
    expect(AUDIT_ACTION_BY_MODERATION).toEqual({
      start_session: 'live.session.started',
      end_session: 'live.session.ended',
      grant_speaker: 'live.speaker.granted',
      decline_speaker: 'live.speaker.declined',
      revoke_speaker: 'live.speaker.revoked',
      grant_presenter: 'live.screen_share.started',
      revoke_presenter: 'live.screen_share.revoked',
      reset_media: 'live.session.media_reset',
      mute_participant: 'live.participant.muted',
      remove_participant: 'live.participant.removed',
    });
    const actions = Object.values(AUDIT_ACTION_BY_MODERATION);
    expect(new Set(actions).size).toBe(MODERATION_ACTION_TYPES.length);
  });
});
