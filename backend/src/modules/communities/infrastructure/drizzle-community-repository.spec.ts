import { Logger } from '@nestjs/common';

import type { Database } from '../../../platform/database';
import type { Community } from '../domain/community';
import { DrizzleCommunityRepository } from './drizzle-community-repository';

/** A deadlock victim, as node-postgres reports it under Drizzle's wrapping. */
const deadlock = () =>
  Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('deadlock detected'), { code: '40P01', severity: 'ERROR' }),
  });

const community = { id: 'c-1', status: 'LOCKED' } as Community;

function repositoryOver(transaction: jest.Mock) {
  return new DrizzleCommunityRepository({ transaction } as unknown as Database);
}

const lock = (repository: DrizzleCommunityRepository) =>
  repository.changeStatus({
    communityId: 'c-1',
    to: 'LOCKED',
    actor: { kind: 'oversight' },
    actorUserId: 'overseer',
    at: new Date(0),
  });

/**
 * The deadlock path, which the lock order should make unreachable: one retry,
 * counted and logged, then `conflict`. The Postgres suite asserts the count
 * stays zero under every race it runs; this pins what happens if it does not.
 */
describe('a deadlock victim', () => {
  let warned: jest.SpyInstance;

  beforeEach(() => {
    warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is retried once, counted, and logged — and the retry’s answer stands', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValueOnce({ kind: 'changed', community });
    const repository = repositoryOver(transaction);
    await expect(lock(repository)).resolves.toEqual({ kind: 'changed', community });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(repository.deadlockRetries).toBe(1);
    expect(warned).toHaveBeenCalledWith({ sqlstate: '40P01' }, 'deadlock victim; retrying once');
  });

  it('answers conflict when the retry is a victim too — never a third attempt', async () => {
    const transaction = jest.fn().mockRejectedValue(deadlock());
    const repository = repositoryOver(transaction);
    await expect(lock(repository)).resolves.toEqual({ kind: 'conflict' });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('never retries anything else', async () => {
    const failure = Object.assign(new Error('check violation'), {
      code: '23514',
      severity: 'ERROR',
    });
    const transaction = jest.fn().mockRejectedValue(failure);
    const repository = repositoryOver(transaction);
    await expect(lock(repository)).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(repository.deadlockRetries).toBe(0);
  });
});
