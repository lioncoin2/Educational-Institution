import type { AccountStatus } from '../domain/account-status';
import type { UserRepository } from '../domain/ports';
import { IdentityAccountDirectorySummary } from './account-directory-summary.service';

/** A repository that answers one fixed status tally; nothing else is called. */
function repositoryWith(counts: ReadonlyMap<AccountStatus, number>): UserRepository {
  return {
    countByStatus: async () => counts,
  } as unknown as UserRepository;
}

describe('IdentityAccountDirectorySummary', () => {
  it('sums the total and breaks out each status (absent statuses read 0)', async () => {
    const service = new IdentityAccountDirectorySummary(
      repositoryWith(
        new Map<AccountStatus, number>([
          ['ACTIVE', 5],
          ['PENDING', 2],
          ['SUSPENDED', 1],
          // DISABLED absent → 0
        ]),
      ),
    );

    const summary = await service.summarize();

    expect(summary).toEqual({ total: 8, active: 5, pending: 2, suspended: 1, disabled: 0 });
  });

  it('answers all-zero for an empty institution', async () => {
    const service = new IdentityAccountDirectorySummary(repositoryWith(new Map()));
    expect(await service.summarize()).toEqual({
      total: 0,
      active: 0,
      pending: 0,
      suspended: 0,
      disabled: 0,
    });
  });

  it('keeps an unexpected status in the total even when it is not broken out', async () => {
    // A status value the current shape does not name still counts toward total —
    // the figure stays truthful; it is never silently dropped.
    const service = new IdentityAccountDirectorySummary(
      repositoryWith(
        new Map([
          ['ACTIVE', 3],
          ['ARCHIVED' as AccountStatus, 4],
        ]),
      ),
    );
    const summary = await service.summarize();
    expect(summary.total).toBe(7);
    expect(summary.active).toBe(3);
  });
});
