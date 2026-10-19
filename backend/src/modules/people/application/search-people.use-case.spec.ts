import {
  err,
  failure,
  ok,
  type Page,
  type PageRequest,
  type Principal,
  type Result,
} from '../../../shared';
import type { AccountSearch, AccountSummary, AuthorizationService } from '../../identity/contracts';
import { SearchPeopleUseCase } from './search-people.use-case';
import { SearchTeachersUseCase } from './search-teachers.use-case';

const teacher: Principal = {
  userId: 'u-1',
  roles: ['TEACHER'],
  permissions: new Set(['people.read']),
};

const student: Principal = {
  userId: 'u-9',
  roles: ['STUDENT'],
  permissions: new Set(['messaging.start_direct_teacher']),
};

class FakeSearch implements AccountSearch {
  readonly calls: { kind: 'people' | 'teachers'; query: string; page: PageRequest }[] = [];
  page: Page<AccountSummary> = { items: [] };

  async search(query: string, page: PageRequest): Promise<Page<AccountSummary>> {
    this.calls.push({ kind: 'people', query, page });
    return this.page;
  }

  async searchTeachers(query: string, page: PageRequest): Promise<Page<AccountSummary>> {
    this.calls.push({ kind: 'teachers', query, page });
    return this.page;
  }
}

function auth(allowed: boolean): AuthorizationService {
  const decision: Result<void> = allowed
    ? ok(undefined)
    : err(failure('forbidden', 'identity.permission_denied', 'Not allowed.'));
  return { can: () => allowed, authorize: () => decision };
}

describe('SearchPeopleUseCase', () => {
  it('refuses a caller without people.read, and does not touch the directory', async () => {
    const search = new FakeSearch();
    const useCase = new SearchPeopleUseCase(auth(false), search);

    const result = await useCase.execute({ principal: teacher, query: 'سا' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('forbidden');
    expect(search.calls).toHaveLength(0); // the right is checked before any read
  });

  it('searches with the default limit when none is given, and returns the page', async () => {
    const search = new FakeSearch();
    search.page = {
      items: [
        { userId: 'u-2', displayName: 'سارة', avatarFileAssetId: 'asset-sara', active: true },
      ],
      nextCursor: 'c1',
    };
    const useCase = new SearchPeopleUseCase(auth(true), search);

    const result = await useCase.execute({ principal: teacher, query: 'سا' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items.map((a) => a.userId)).toEqual(['u-2']);
      // The picture reference flows through untouched — the use case neither
      // drops it nor turns it into a link (that is the response layer's job).
      expect(result.value.items[0].avatarFileAssetId).toBe('asset-sara');
      expect(result.value.nextCursor).toBe('c1');
    }
    expect(search.calls[0]).toEqual({ kind: 'people', query: 'سا', page: { limit: 50 } });
  });

  it('passes a given cursor and limit through unchanged', async () => {
    const search = new FakeSearch();
    const useCase = new SearchPeopleUseCase(auth(true), search);

    await useCase.execute({ principal: teacher, query: 'سا', cursor: 'abc', limit: 10 });

    expect(search.calls[0].page).toEqual({ limit: 10, cursor: 'abc' });
  });
});

describe('SearchTeachersUseCase', () => {
  it('refuses a caller without the teacher-messaging capability, and reads nothing', async () => {
    const search = new FakeSearch();
    const useCase = new SearchTeachersUseCase(auth(false), search);

    const result = await useCase.execute({ principal: student, query: 'عب' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('forbidden');
    expect(search.calls).toHaveLength(0);
  });

  it('searches TEACHERS (not the general directory) with the default limit', async () => {
    const search = new FakeSearch();
    search.page = {
      items: [{ userId: 'u-2', displayName: 'الأستاذ', avatarFileAssetId: null, active: true }],
    };
    const useCase = new SearchTeachersUseCase(auth(true), search);

    const result = await useCase.execute({ principal: student, query: 'عب' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items.map((a) => a.userId)).toEqual(['u-2']);
    expect(search.calls[0]).toEqual({ kind: 'teachers', query: 'عب', page: { limit: 50 } });
  });

  it('passes a given cursor and limit through unchanged', async () => {
    const search = new FakeSearch();
    const useCase = new SearchTeachersUseCase(auth(true), search);

    await useCase.execute({ principal: student, query: 'عب', cursor: 'abc', limit: 10 });

    expect(search.calls[0]).toEqual({
      kind: 'teachers',
      query: 'عب',
      page: { limit: 10, cursor: 'abc' },
    });
  });
});
