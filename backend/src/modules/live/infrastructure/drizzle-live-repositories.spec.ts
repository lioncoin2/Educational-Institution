import { Logger } from '@nestjs/common';

import type { Database } from '../../../platform/database';
import { asId } from '../../../shared';
import type { EndInput, PresenterOpenOutcome } from '../domain/ports';
import { newPresenterGrant } from '../domain/presenter-grant';
import { DrizzleLiveStore } from './drizzle-live-repositories';

/** A Postgres error as node-postgres reports it under Drizzle's wrapping. */
const failure = (code: string, fields: Record<string, string> = {}) =>
  Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('postgres error'), { code, severity: 'ERROR', ...fields }),
  });
const deadlock = () => failure('40P01');

function storeOver(transaction: jest.Mock): DrizzleLiveStore {
  return new DrizzleLiveStore({ transaction } as unknown as Database);
}

const at = new Date('2026-09-27T10:00:00.000Z');
const endInput: EndInput = {
  sessionId: 'session-1',
  at,
  endedBy: 'teacher-1',
  reason: 'moderator',
  moderation: {
    id: asId<'ModerationAction'>('action-1'),
    sessionId: 'session-1',
    actorUserId: 'teacher-1',
    targetUserId: null,
    type: 'end_session',
    at,
  },
};

/**
 * The deadlock path, which the one lock order should make unreachable: one
 * retry, counted and logged; a second victim is thrown, since no port has a
 * "contended" answer. The Postgres suite asserts the count stays zero under
 * every race it runs; this pins what happens if it does not.
 */
describe('a deadlock victim', () => {
  let warned: jest.SpyInstance;

  beforeEach(() => {
    warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('is retried once, counted, and logged — and the retry’s answer stands', async () => {
    const answer = { ended: false, session: { id: 'session-1' } };
    const transaction = jest.fn().mockRejectedValueOnce(deadlock()).mockResolvedValueOnce(answer);
    const store = storeOver(transaction);
    await expect(store.sessions.end(endInput)).resolves.toBe(answer);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(store.deadlockRetries).toBe(1);
    expect(warned).toHaveBeenCalledWith({ sqlstate: '40P01' }, 'deadlock victim; retrying once');
  });

  it('throws the second — never a third attempt', async () => {
    const second = deadlock();
    const transaction = jest.fn().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(second);
    const store = storeOver(transaction);
    await expect(store.sessions.end(endInput)).rejects.toBe(second);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(store.deadlockRetries).toBe(1);
  });

  it('counts across the three ports, which share one store', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(deadlock())
      .mockResolvedValueOnce({ request: null, presenter: null, stateVersion: 0 });
    const store = storeOver(transaction);
    await store.sessions.end(endInput);
    await store.requests.expireIneligible('session-1', 'student-1', at);
    expect(store.deadlockRetries).toBe(2);
  });

  it('never retries anything else', async () => {
    const check = failure('23514', { constraint: 'live_sessions_moderator_end_named' });
    const transaction = jest.fn().mockRejectedValue(check);
    const store = storeOver(transaction);
    await expect(store.sessions.end(endInput)).rejects.toBe(check);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(store.deadlockRetries).toBe(0);
    expect(warned).not.toHaveBeenCalled();
  });
});

/**
 * The presenter slot's backstop (live.md §10.1): a claim reads the open grant
 * under the session's lock, so only a writer that bypassed the lock can make
 * its insert trip the partial unique index. Then the transaction has rolled
 * back, and the claim is decided again — answered by the slot's holder.
 */
describe('a claim that trips the presenter slot’s unique index', () => {
  const grant = newPresenterGrant({
    id: asId<'PresenterGrant'>('grant-1'),
    sessionId: 'session-1',
    userId: 'teacher-1',
    at,
  });
  const moderation = {
    id: asId<'ModerationAction'>('action-2'),
    sessionId: 'session-1',
    actorUserId: 'teacher-1',
    targetUserId: 'teacher-1',
    type: 'grant_presenter' as const,
    at,
  };

  it('is decided again, and answered as the holder says', async () => {
    const holder: PresenterOpenOutcome = {
      kind: 'occupied',
      grant: { ...grant, id: asId<'PresenterGrant'>('grant-rival'), userId: 'teacher-2' },
      stateVersion: 2,
    };
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(
        failure('23505', { constraint: 'live_presenter_grants_one_open_per_session' }),
      )
      .mockResolvedValueOnce(holder);
    const store = storeOver(transaction);
    await expect(store.presenters.open(grant, moderation)).resolves.toBe(holder);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(store.deadlockRetries).toBe(0);
  });

  it('throws any other unique violation — a reused grant id is a fault, not a rival', async () => {
    const duplicate = failure('23505', { constraint: 'live_presenter_grants_pkey' });
    const transaction = jest.fn().mockRejectedValue(duplicate);
    const store = storeOver(transaction);
    await expect(store.presenters.open(grant, moderation)).rejects.toBe(duplicate);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
