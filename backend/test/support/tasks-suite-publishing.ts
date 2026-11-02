import { codeOf, draft, GROUPS, STAFF, value } from './tasks-fixtures';
import { tasksHarness, type TasksPorts } from './tasks-harness';

/**
 * Publishing and its authorization (roadmap §2–§3, ADR 0052 §2, §10): who a task
 * reaches, idempotent retries, narrowing to a group, and who may do what.
 */
export function describePublishing(makePorts: () => Promise<TasksPorts>): void {
  let h: ReturnType<typeof tasksHarness>;
  beforeEach(async () => {
    h = tasksHarness(await makePorts(), STAFF, GROUPS);
  });

  const recipientsOf = async (taskId: string) => {
    const page = value(
      await h.track.execute({ principal: h.principal('owner'), taskId, filter: 'ALL', limit: 200 }),
    );
    return page.items.map((row) => row.assignment.recipientId).sort();
  };

  it('reaches every active member of the audience — never the publisher, a suspended account or a student', async () => {
    const outcome = value(
      await h.publish.execute({
        principal: h.principal('admin-1'),
        ...draft({ audiences: ['TEACHERS', 'ADMINISTRATION'] }),
      }),
    );
    expect(outcome.status).toBe('created');
    expect(await recipientsOf(outcome.task.id)).toEqual([
      'admin-2',
      'assistant-1',
      'teacher-1',
      'teacher-2',
    ]);
    const published = h.facts.filter((f) => f.name === 'tasks.task.published');
    expect(published).toHaveLength(1);
  });

  it('answers a retried publish with the first task, and publishes nothing twice', async () => {
    const first = value(
      await h.publish.execute({
        principal: h.principal('owner'),
        ...draft(),
        clientRequestId: 'key-12345678',
      }),
    );
    const again = value(
      await h.publish.execute({
        principal: h.principal('owner'),
        ...draft(),
        clientRequestId: 'key-12345678',
      }),
    );
    expect(again.status).toBe('duplicate');
    expect(again.task.id).toBe(first.task.id);
    expect(h.facts.filter((f) => f.name === 'tasks.task.published')).toHaveLength(1);
    expect(await recipientsOf(first.task.id)).toHaveLength(3);
  });

  it('narrows an audience to the members of an existing group', async () => {
    const outcome = value(
      await h.publish.execute({
        principal: h.principal('owner'),
        ...draft({ audiences: ['TEACHERS', 'SUPERVISORS'], communityId: 'group-1' }),
      }),
    );
    expect(await recipientsOf(outcome.task.id)).toEqual(['supervisor-1', 'teacher-1']);
    const unknown = await h.publish.execute({
      principal: h.principal('owner'),
      ...draft({ communityId: 'no-such-group' }),
    });
    expect(codeOf(unknown)).toBe('tasks.community_not_found');
  });

  it('refuses a task nobody could act on, an unknown audience, and an empty one', async () => {
    const owner = h.principal('owner');
    expect(codeOf(await h.publish.execute({ principal: owner, ...draft({ buttons: [] }) }))).toBe(
      'tasks.no_way_to_respond',
    );
    expect(codeOf(await h.publish.execute({ principal: owner, ...draft({ audiences: [] }) }))).toBe(
      'tasks.audience_invalid',
    );
    const lonely = tasksHarness(await makePorts(), [{ id: 'owner', roles: ['OWNER'] }]);
    expect(
      codeOf(await lonely.publish.execute({ principal: lonely.principal('owner'), ...draft() })),
    ).toBe('tasks.no_recipients');
  });

  it('lets only the owner and the administration publish and follow tasks', async () => {
    for (const who of ['teacher-1', 'supervisor-1', 'student-1']) {
      expect(codeOf(await h.publish.execute({ principal: h.principal(who), ...draft() }))).toBe(
        'identity.permission_denied',
      );
      expect(codeOf(await h.list.execute({ principal: h.principal(who), filter: {} }))).toBe(
        'identity.permission_denied',
      );
    }
    expect(
      codeOf(await h.listMine.execute({ principal: h.principal('student-1'), scope: 'OPEN' })),
    ).toBe('identity.permission_denied');
  });

  it('keeps templates and re-publishing the owner’s', async () => {
    const task = value(
      await h.publish.execute({ principal: h.principal('owner'), ...draft() }),
    ).task;
    const admin = h.principal('admin-1');
    expect(codeOf(await h.saveTemplate.execute({ principal: admin, fromTaskId: task.id }))).toBe(
      'identity.permission_denied',
    );
    expect(codeOf(await h.republish.execute({ principal: admin, taskId: task.id }))).toBe(
      'identity.permission_denied',
    );
  });

  it('hides someone else’s assignment behind the same answer as one that never existed', async () => {
    const task = value(
      await h.publish.execute({ principal: h.principal('owner'), ...draft() }),
    ).task;
    const mine = value(
      await h.getMineByTask.execute({ principal: h.principal('teacher-1'), taskId: task.id }),
    );
    const other = h.principal('teacher-2');
    expect(
      codeOf(await h.acknowledge.execute({ principal: other, assignmentId: mine.assignment.id })),
    ).toBe('tasks.assignment_not_found');
    expect(codeOf(await h.acknowledge.execute({ principal: other, assignmentId: 'nope' }))).toBe(
      'tasks.assignment_not_found',
    );
  });

  it('finds tasks by text and by state, newest first', async () => {
    const owner = h.principal('owner');
    value(await h.publish.execute({ principal: owner, ...draft({ title: 'خطة الأسبوع' }) }));
    const second = value(
      await h.publish.execute({ principal: owner, ...draft({ title: 'تقرير الحضور' }) }),
    ).task;
    value(await h.cancel.execute({ principal: owner, taskId: second.id }));

    const byText = value(await h.list.execute({ principal: owner, filter: { text: 'الأسبوع' } }));
    expect(byText.items.map((s) => s.task.title)).toEqual(['خطة الأسبوع']);
    const cancelled = value(
      await h.list.execute({ principal: owner, filter: { state: 'CANCELLED' } }),
    );
    expect(cancelled.items.map((s) => s.task.id)).toEqual([second.id]);
    const all = value(await h.list.execute({ principal: owner, filter: {} }));
    expect(all.items.map((s) => s.task.title)).toEqual(['تقرير الحضور', 'خطة الأسبوع']);
  });
}
