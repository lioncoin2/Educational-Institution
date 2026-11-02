import { codeOf, draft, GROUPS, STAFF, value } from './tasks-fixtures';
import { tasksHarness, type TasksPorts } from './tasks-harness';

/**
 * The whole cycle (roadmap §3–§11, "قاعدة نهائية"): publish → acknowledge →
 * complete → report → review → archive → reopen, with edits, cancellation,
 * reminders and reassignment — every state transition and its refusals.
 */
export function describeWorkflow(makePorts: () => Promise<TasksPorts>): void {
  let h: ReturnType<typeof tasksHarness>;
  beforeEach(async () => {
    h = tasksHarness(await makePorts(), STAFF, GROUPS);
  });

  const owner = () => h.principal('owner');
  const publish = async (over: Record<string, unknown> = {}) =>
    value(await h.publish.execute({ principal: owner(), ...draft(over) })).task;
  const mineOf = async (who: string, taskId: string) =>
    value(await h.getMineByTask.execute({ principal: h.principal(who), taskId }));
  const stateOf = async (taskId: string) =>
    value(await h.get.execute({ principal: owner(), taskId })).task;
  const TEACHERS = ['teacher-1', 'teacher-2', 'assistant-1'];

  it('runs a report task to the archive: acknowledge, report, changes requested, resubmit, approve', async () => {
    const task = await publish({ reportRequired: true });
    const t1 = await mineOf('teacher-1', task.id);
    const me = h.principal('teacher-1');

    expect(
      codeOf(
        await h.complete.execute({ principal: me, assignmentId: t1.assignment.id, report: 'x' }),
      ),
    ).toBe('tasks.acknowledge_first');
    value(await h.acknowledge.execute({ principal: me, assignmentId: t1.assignment.id }));
    expect(
      codeOf(await h.complete.execute({ principal: me, assignmentId: t1.assignment.id })),
    ).toBe('tasks.report_required');
    value(
      await h.complete.execute({
        principal: me,
        assignmentId: t1.assignment.id,
        report: 'الخطة جاهزة',
      }),
    );

    const report = value(
      await h.getMine.execute({ principal: me, assignmentId: t1.assignment.id }),
    ).report!;
    expect(report.status).toBe('PENDING_REVIEW');
    const admin = h.principal('admin-1');
    expect(
      codeOf(
        await h.review.execute({
          principal: admin,
          reportId: report.id,
          version: 1,
          decision: 'CHANGES_REQUESTED',
        }),
      ),
    ).toBe('tasks.note_required');
    value(
      await h.review.execute({
        principal: admin,
        reportId: report.id,
        version: 1,
        decision: 'CHANGES_REQUESTED',
        note: 'أضيفي الأهداف',
      }),
    );
    const sentBack = value(
      await h.getMine.execute({ principal: me, assignmentId: t1.assignment.id }),
    );
    expect(sentBack.report!.status).toBe('CHANGES_REQUESTED');
    expect(sentBack.reviews.map((r) => r.note)).toEqual(['أضيفي الأهداف']);

    expect(
      codeOf(
        await h.writeReport.execute({
          principal: me,
          assignmentId: t1.assignment.id,
          version: 9,
          body: 'x',
        }),
      ),
    ).toBe('tasks.revision_conflict');
    const resubmitted = value(
      await h.writeReport.execute({
        principal: me,
        assignmentId: t1.assignment.id,
        version: 1,
        body: 'الخطة مع الأهداف',
      }),
    );
    expect(resubmitted).toMatchObject({ status: 'PENDING_REVIEW', version: 2 });
    value(
      await h.review.execute({
        principal: h.principal('admin-2'),
        reportId: report.id,
        version: 2,
        decision: 'APPROVED',
      }),
    );

    // The others finish too; only then does the task settle into the archive.
    for (const who of ['teacher-2', 'assistant-1']) {
      const mine = await mineOf(who, task.id);
      const p = h.principal(who);
      value(await h.acknowledge.execute({ principal: p, assignmentId: mine.assignment.id }));
      value(
        await h.complete.execute({
          principal: p,
          assignmentId: mine.assignment.id,
          report: `تقرير ${who}`,
        }),
      );
      expect((await stateOf(task.id)).archivedAt).toBeNull();
      const pending = value(
        await h.getMine.execute({ principal: p, assignmentId: mine.assignment.id }),
      ).report!;
      value(
        await h.review.execute({
          principal: admin,
          reportId: pending.id,
          version: 1,
          decision: 'APPROVED',
        }),
      );
    }
    expect((await stateOf(task.id)).archivedAt).not.toBeNull();

    const detail = value(await h.getReport.execute({ principal: owner(), reportId: report.id }));
    expect(detail.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(detail.reviews.map((r) => r.decision)).toEqual(['CHANGES_REQUESTED', 'APPROVED']);
    expect(detail.report.approvedBy).toBe('admin-2');

    const log = value(await h.history.execute({ principal: owner(), taskId: task.id, limit: 200 }));
    const actions = log.items.map((e) => e.action);
    expect(actions[0]).toBe('TASK_PUBLISHED');
    expect(actions[actions.length - 1]).toBe('TASK_ARCHIVED');
    expect(actions).toEqual(
      expect.arrayContaining(['REPORT_CHANGES_REQUESTED', 'REPORT_APPROVED', 'REPORT_SUBMITTED']),
    );
    // Report text never enters the log.
    expect(JSON.stringify(log.items)).not.toContain('الخطة');
  });

  it('approves reports at once in AUTO mode and archives when everyone is done', async () => {
    const task = await publish({
      reportRequired: true,
      approvalMode: 'AUTO',
      buttons: ['COMPLETE'],
    });
    for (const who of TEACHERS) {
      const mine = await mineOf(who, task.id);
      value(
        await h.complete.execute({
          principal: h.principal(who),
          assignmentId: mine.assignment.id,
          report: 'تم',
        }),
      );
      const report = value(
        await h.getMine.execute({ principal: h.principal(who), assignmentId: mine.assignment.id }),
      ).report!;
      expect(report).toMatchObject({ status: 'APPROVED', approvedBy: null });
    }
    expect((await stateOf(task.id)).archivedAt).not.toBeNull();
  });

  it('completes an acknowledge-only task by acknowledging, and treats a repeat as nothing', async () => {
    const task = await publish({ buttons: ['ACKNOWLEDGE'] });
    for (const who of TEACHERS) {
      const mine = await mineOf(who, task.id);
      const done = value(
        await h.acknowledge.execute({
          principal: h.principal(who),
          assignmentId: mine.assignment.id,
        }),
      );
      expect(done.status).toBe('COMPLETED');
      const again = value(
        await h.acknowledge.execute({
          principal: h.principal(who),
          assignmentId: mine.assignment.id,
        }),
      );
      expect(again.completedAt).toEqual(done.completedAt);
    }
    expect((await stateOf(task.id)).archivedAt).not.toBeNull();
  });

  it('reminds only those who have not responded at all', async () => {
    const task = await publish();
    const t1 = await mineOf('teacher-1', task.id);
    value(
      await h.acknowledge.execute({
        principal: h.principal('teacher-1'),
        assignmentId: t1.assignment.id,
      }),
    );
    const result = value(
      await h.remind.execute({ principal: h.principal('admin-1'), taskId: task.id }),
    );
    expect(result.reminded).toBe(2);
    const fact = h.facts.find((f) => f.name === 'tasks.task.reminded');
    expect((fact?.payload as { recipientUserIds: string[] }).recipientUserIds.sort()).toEqual([
      'assistant-1',
      'teacher-2',
    ]);
  });

  it('edits content any time, settings only before a response, and can ask for acknowledgement again', async () => {
    const task = await publish();
    const admin = h.principal('admin-2');
    expect(
      codeOf(await h.edit.execute({ principal: admin, taskId: task.id, revision: 7, title: 'x' })),
    ).toBe('tasks.revision_conflict');
    const t1 = await mineOf('teacher-1', task.id);
    value(
      await h.acknowledge.execute({
        principal: h.principal('teacher-1'),
        assignmentId: t1.assignment.id,
      }),
    );
    expect(
      codeOf(
        await h.edit.execute({
          principal: admin,
          taskId: task.id,
          revision: 1,
          reportRequired: true,
        }),
      ),
    ).toBe('tasks.settings_locked');

    const edited = value(
      await h.edit.execute({
        principal: admin,
        taskId: task.id,
        revision: 1,
        title: 'العنوان الجديد',
        requireReacknowledge: true,
      }),
    );
    expect(edited.revision).toBe(2);
    const again = await mineOf('teacher-1', task.id);
    expect(again.assignment).toMatchObject({ status: 'PENDING', acknowledgedAt: null });
    expect(again.task.title).toBe('العنوان الجديد');
    const detail = value(await h.get.execute({ principal: owner(), taskId: task.id }));
    expect(detail.revisions.map((r) => r.title)).toEqual(['تحضير درس الغد', 'العنوان الجديد']);
  });

  it('cancels into the archive, refuses responses, and reopens with the history kept', async () => {
    const task = await publish();
    const t1 = await mineOf('teacher-1', task.id);
    value(await h.cancel.execute({ principal: h.principal('admin-1'), taskId: task.id }));
    const cancelled = await stateOf(task.id);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelledBy: 'admin-1' });
    expect(cancelled.archivedAt).not.toBeNull();
    expect(
      codeOf(
        await h.acknowledge.execute({
          principal: h.principal('teacher-1'),
          assignmentId: t1.assignment.id,
        }),
      ),
    ).toBe('tasks.task_not_active');
    expect(codeOf(await h.reopen.execute({ principal: owner(), taskId: 'nope' }))).toBe(
      'tasks.task_not_found',
    );
    value(await h.reopen.execute({ principal: h.principal('admin-2'), taskId: task.id }));
    expect(await stateOf(task.id)).toMatchObject({
      status: 'OPEN',
      archivedAt: null,
      cancelledAt: null,
    });
    value(
      await h.acknowledge.execute({
        principal: h.principal('teacher-1'),
        assignmentId: t1.assignment.id,
      }),
    );
  });

  it('hands a pending task to another member of its audience and keeps the first holder on record', async () => {
    const task = await publish();
    const t1 = await mineOf('teacher-1', task.id);
    const admin = h.principal('admin-1');
    for (const target of ['student-1', 'teacher-off', 'teacher-2', 'teacher-1']) {
      expect(
        codeOf(
          await h.reassign.execute({
            principal: admin,
            taskId: task.id,
            assignmentId: t1.assignment.id,
            toUserId: target,
          }),
        ),
      ).toBe('tasks.reassign_target_invalid');
    }
    // A teacher who joins after the task was published: eligible, not yet holding it.
    const staff = [...STAFF];
    const extra = tasksHarness(await makePorts(), staff);
    const task2 = value(
      await extra.publish.execute({ principal: extra.principal('owner'), ...draft() }),
    ).task;
    staff.push({ id: 'teacher-new', roles: ['TEACHER'] });
    const old = value(
      await extra.getMineByTask.execute({
        principal: extra.principal('teacher-1'),
        taskId: task2.id,
      }),
    );
    const opened = value(
      await extra.reassign.execute({
        principal: extra.principal('admin-1'),
        taskId: task2.id,
        assignmentId: old.assignment.id,
        toUserId: 'teacher-new',
      }),
    );
    expect(opened).toMatchObject({
      recipientId: 'teacher-new',
      replaces: old.assignment.id,
      status: 'PENDING',
    });
    expect(
      codeOf(
        await extra.acknowledge.execute({
          principal: extra.principal('teacher-1'),
          assignmentId: old.assignment.id,
        }),
      ),
    ).toBe('tasks.assignment_closed');
    value(
      await extra.acknowledge.execute({
        principal: extra.principal('teacher-new'),
        assignmentId: opened.id,
      }),
    );
    const rows = value(
      await extra.track.execute({
        principal: extra.principal('owner'),
        taskId: task2.id,
        filter: 'ALL',
      }),
    );
    const closed = rows.items.find((r) => r.assignment.id === old.assignment.id)!;
    expect(closed.assignment).toMatchObject({
      status: 'REASSIGNED',
      reassignedTo: opened.id,
      reassignedBy: 'admin-1',
    });
  });
}
