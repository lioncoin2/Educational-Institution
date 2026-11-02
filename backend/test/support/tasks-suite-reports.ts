import { codeOf, draft, GROUPS, STAFF, value } from './tasks-fixtures';
import { tasksHarness, type TasksPorts } from './tasks-harness';

/**
 * Reports administration, templates and re-publishing, the dashboard and the
 * export (roadmap §5–§7, §10, §12–§13).
 */
export function describeReportsAndDashboard(makePorts: () => Promise<TasksPorts>): void {
  let h: ReturnType<typeof tasksHarness>;
  beforeEach(async () => {
    h = tasksHarness(await makePorts(), STAFF, GROUPS);
  });

  const owner = () => h.principal('owner');
  const reportTask = async (over: Record<string, unknown> = {}) =>
    value(
      await h.publish.execute({
        principal: owner(),
        ...draft({ reportRequired: true, buttons: ['COMPLETE'], ...over }),
      }),
    ).task;
  const submit = async (who: string, taskId: string, body = `تقرير ${who}`) => {
    const mine = value(await h.getMineByTask.execute({ principal: h.principal(who), taskId }));
    value(
      await h.complete.execute({
        principal: h.principal(who),
        assignmentId: mine.assignment.id,
        report: body,
      }),
    );
    return value(
      await h.getMine.execute({ principal: h.principal(who), assignmentId: mine.assignment.id }),
    ).report!;
  };

  it('classifies reports by the task kind and lists them by category, never deleted ones', async () => {
    const attendance = await reportTask({ kind: 'ATTENDANCE' });
    const teaching = await reportTask({ kind: 'TEACHING' });
    const a = await submit('teacher-1', attendance.id);
    const t = await submit('teacher-1', teaching.id);
    expect(a.category).toBe('ATTENDANCE');
    expect(t.category).toBe('TEACHERS');
    const page = value(
      await h.listReports.execute({ principal: owner(), filter: { category: 'ATTENDANCE' } }),
    );
    expect(page.items.map((s) => s.report.id)).toEqual([a.id]);

    value(await h.deleteReport.execute({ principal: h.principal('admin-1'), reportId: a.id }));
    const after = value(
      await h.listReports.execute({ principal: owner(), filter: { category: 'ATTENDANCE' } }),
    );
    expect(after.items).toEqual([]);
    const deleted = value(
      await h.listReports.execute({ principal: owner(), filter: { reportStatus: 'DELETED' } }),
    );
    expect(deleted.items.map((s) => s.report.id)).toEqual([a.id]);
  });

  it('lets the author submit a deleted report again, and the administration edit one as a new version', async () => {
    const task = await reportTask();
    const report = await submit('teacher-1', task.id);
    value(await h.deleteReport.execute({ principal: h.principal('admin-1'), reportId: report.id }));
    const mine = value(
      await h.getMineByTask.execute({ principal: h.principal('teacher-1'), taskId: task.id }),
    );
    const again = value(
      await h.writeReport.execute({
        principal: h.principal('teacher-1'),
        assignmentId: mine.assignment.id,
        version: 1,
        body: 'من جديد',
      }),
    );
    expect(again).toMatchObject({ status: 'PENDING_REVIEW', version: 2, deletedAt: null });

    const edited = value(
      await h.editReport.execute({
        principal: h.principal('admin-2'),
        reportId: report.id,
        version: 2,
        body: 'بتصحيح الإدارة',
      }),
    );
    expect(edited.version).toBe(3);
    const detail = value(await h.getReport.execute({ principal: owner(), reportId: report.id }));
    expect(detail.versions.map((v) => v.editedBy)).toEqual(['teacher-1', 'teacher-1', 'admin-2']);
  });

  it('never lets a recipient edit or review through the administration’s routes', async () => {
    const task = await reportTask();
    const report = await submit('teacher-1', task.id);
    const me = h.principal('teacher-1');
    expect(
      codeOf(
        await h.review.execute({
          principal: me,
          reportId: report.id,
          version: 1,
          decision: 'APPROVED',
        }),
      ),
    ).toBe('identity.permission_denied');
    expect(codeOf(await h.deleteReport.execute({ principal: me, reportId: report.id }))).toBe(
      'identity.permission_denied',
    );
  });

  it('saves a task as a template and re-publishes a past task as a new, independent one', async () => {
    const original = await reportTask({ title: 'متابعة الحضور', kind: 'ATTENDANCE' });
    await submit('teacher-1', original.id);
    const template = value(
      await h.saveTemplate.execute({ principal: owner(), fromTaskId: original.id }),
    );
    expect(template).toMatchObject({
      title: 'متابعة الحضور',
      kind: 'ATTENDANCE',
      reportRequired: true,
    });
    const listed = value(await h.listTemplates.execute({ principal: h.principal('admin-1') }));
    expect(listed.items.map((t) => t.id)).toEqual([template.id]);

    const again = value(
      await h.republish.execute({
        principal: owner(),
        taskId: original.id,
        title: 'متابعة الحضور ٢',
      }),
    );
    expect(again.status).toBe('created');
    expect(again.task).toMatchObject({
      republishedFrom: original.id,
      title: 'متابعة الحضور ٢',
      revision: 1,
    });
    const counts = value(await h.get.execute({ principal: owner(), taskId: again.task.id })).counts;
    expect(counts).toMatchObject({ targets: 3, responded: 0, completed: 0, reportsPending: 0 });

    value(await h.deleteTemplate.execute({ principal: owner(), templateId: template.id }));
    expect(
      codeOf(await h.deleteTemplate.execute({ principal: owner(), templateId: template.id })),
    ).toBe('tasks.template_not_found');
  });

  it('counts responses on the dashboard by audience and person — listed, never ranked', async () => {
    const task = value(
      await h.publish.execute({
        principal: owner(),
        ...draft({ audiences: ['TEACHERS', 'SUPERVISORS'] }),
      }),
    ).task;
    const s1 = value(
      await h.getMineByTask.execute({ principal: h.principal('supervisor-1'), taskId: task.id }),
    );
    value(
      await h.acknowledge.execute({
        principal: h.principal('supervisor-1'),
        assignmentId: s1.assignment.id,
      }),
    );
    value(
      await h.complete.execute({
        principal: h.principal('supervisor-1'),
        assignmentId: s1.assignment.id,
      }),
    );

    const board = value(
      await h.dashboard.execute({ principal: h.principal('admin-1'), filter: {} }),
    );
    expect(board.totals).toMatchObject({ tasks: 1, assignments: 4, responded: 1, completed: 1 });
    expect(board.byAudience.map((g) => [g.audience, g.assignments, g.completed])).toEqual([
      ['SUPERVISORS', 1, 1],
      ['TEACHERS', 3, 0],
    ]);
    expect(board.byPerson.map((p) => p.personId)).toEqual([
      'assistant-1',
      'supervisor-1',
      'teacher-1',
      'teacher-2',
    ]);

    const supervisors = value(
      await h.dashboard.execute({ principal: owner(), filter: { audience: 'SUPERVISORS' } }),
    );
    expect(supervisors.totals).toMatchObject({ assignments: 1, completed: 1 });
  });

  it('exports one row per addressee, exactly the chosen filters', async () => {
    const task = await reportTask();
    await submit('teacher-2', task.id);
    const rows = value(
      await h.exportRows.execute({ principal: owner(), filter: { personId: 'teacher-2' } }),
    );
    expect(rows.rows.map((r) => [r.assignment.recipientId, r.report?.status])).toEqual([
      ['teacher-2', 'PENDING_REVIEW'],
    ]);
    expect(rows.truncated).toBe(false);
    expect(rows.names.get('teacher-2')).toBe('name:teacher-2');
  });
}
