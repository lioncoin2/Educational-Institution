import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  notificationsHarness,
  type NotificationsHarness,
} from '../../../../test/support/notifications-harness';
import type { Principal } from '../../../shared';

describe('conversation mute use cases', () => {
  let h: NotificationsHarness;
  let ali: Principal;
  let sara: Principal;

  beforeEach(async () => {
    h = await notificationsHarness();
    ali = h.messaging.person('STUDENT', 'علي');
    sara = h.messaging.person('STUDENT', 'سارة');
  });

  afterEach(async () => {
    await h.cleanup();
  });

  const mutedIds = async (principal: Principal): Promise<string[]> =>
    expectOk(await h.listMuted.execute({ principal })).map((mute) => mute.conversationId);

  it('mutes a conversation and lists it', async () => {
    expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-1' }));
    expect(await mutedIds(ali)).toEqual(['c-1']);
  });

  it('is idempotent — muting twice leaves one entry', async () => {
    expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-1' }));
    expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-1' }));
    expect(await mutedIds(ali)).toEqual(['c-1']);
  });

  it('unmutes, and unmuting again is harmless', async () => {
    expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-1' }));
    expectOk(await h.unmute.execute({ principal: ali, conversationId: 'c-1' }));
    expect(await mutedIds(ali)).toEqual([]);
    expectOk(await h.unmute.execute({ principal: ali, conversationId: 'c-1' }));
    expect(await mutedIds(ali)).toEqual([]);
  });

  it('lists newest first', async () => {
    expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-1' }));
    h.clock.advance(60);
    expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-2' }));
    expect(await mutedIds(ali)).toEqual(['c-2', 'c-1']);
  });

  it('keeps each person’s mutes to themselves', async () => {
    expectOk(await h.mute.execute({ principal: ali, conversationId: 'c-1' }));
    expect(await mutedIds(sara)).toEqual([]);
  });

  it('rejects an empty conversation id', async () => {
    expect(expectErr(await h.mute.execute({ principal: ali, conversationId: '' }))).toMatchObject({
      kind: 'validation',
      code: 'notifications.conversation_id_invalid',
    });
  });

  it('rejects a conversation id that is too long', async () => {
    expect(
      expectErr(await h.mute.execute({ principal: ali, conversationId: 'x'.repeat(129) })),
    ).toMatchObject({ code: 'notifications.conversation_id_invalid' });
  });

  it('is safe under concurrent mutes of the same conversation', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => h.mute.execute({ principal: ali, conversationId: 'c-1' })),
    );
    expect(await mutedIds(ali)).toEqual(['c-1']);
  });
});
