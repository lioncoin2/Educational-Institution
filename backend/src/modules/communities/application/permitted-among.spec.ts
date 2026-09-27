import type { Principal } from '../../../shared';
import {
  communitiesHarness,
  type CommunitiesHarness,
} from '../../../../test/support/communities-harness';

/**
 * How `permittedAmong` answers, in memory — what it answers is the shared
 * contract suite's, on both stores. Identity is asked once per ceiling
 * permission, and the store once, about those holding the whole ceiling
 * only. A failure of either REJECTS: an empty answer would say "nobody may",
 * and a caller that ejects the ineligible would eject everyone on it.
 */
describe('permittedAmong — cost and failure', () => {
  let h: CommunitiesHarness;
  let admin: Principal;
  let communityId: string;

  beforeEach(async () => {
    h = communitiesHarness();
    admin = h.person('admin-1', ['ADMIN']);
    communityId = await h.community(admin);
    h.person('student-1', ['STUDENT']);
    h.person('supervisor-1', ['SUPERVISOR']); // takes part, but never raises a hand
    await h.addPeople(admin, communityId, 'student-1', 'supervisor-1');
  });

  afterEach(() => jest.restoreAllMocks());

  const remain = () =>
    h.authorization.permittedAmong(communityId, ['student-1'], 'community.live.remain');

  it('asks identity once per ceiling permission, then reads once — only those holding it all', async () => {
    const asked = jest.spyOn(h.accounts, 'withPermission');
    const read = jest.spyOn(h.store, 'authorityOfMany');
    expect(
      await h.authorization.permittedAmong(
        communityId,
        ['supervisor-1', 'student-1', 'stranger'],
        'community.live.raise_hand',
      ),
    ).toEqual(['student-1']);
    // Each permission asks only about those who held every one before it.
    expect(asked.mock.calls).toEqual([
      [['supervisor-1', 'student-1', 'stranger'], 'communities.read'],
      [['supervisor-1', 'student-1'], 'live.raise_hand'],
    ]);
    expect(read.mock.calls).toEqual([[communityId, ['student-1']]]);
  });

  it('reads nothing when nobody holds the ceiling', async () => {
    const read = jest.spyOn(h.store, 'authorityOfMany');
    expect(
      await h.authorization.permittedAmong(
        communityId,
        ['supervisor-1', 'stranger'],
        'community.live.raise_hand',
      ),
    ).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects when the store read fails — never [] for "could not tell"', async () => {
    jest
      .spyOn(h.store, 'authorityOfMany')
      .mockRejectedValueOnce(new Error('connection terminated'));
    await expect(remain()).rejects.toThrow('connection terminated');
    // Nothing of the failure is kept: the next call is answered afresh.
    expect(await remain()).toEqual(['student-1']);
  });

  it('rejects when the directory fails, on the first ceiling permission or a later one', async () => {
    const read = jest.spyOn(h.store, 'authorityOfMany');
    const asked = jest.spyOn(h.accounts, 'withPermission');
    asked.mockRejectedValueOnce(new Error('identity unavailable'));
    await expect(remain()).rejects.toThrow('identity unavailable');
    asked
      .mockResolvedValueOnce(new Set(['student-1']))
      .mockRejectedValueOnce(new Error('identity unavailable'));
    await expect(remain()).rejects.toThrow('identity unavailable');
    // Without identity's answer, nothing was read.
    expect(read).not.toHaveBeenCalled();
    expect(await remain()).toEqual(['student-1']);
  });
});
