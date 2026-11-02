import {
  completionMethod,
  normaliseButtons,
  normaliseContent,
  reportCategoryOf,
  validateSettings,
  type TaskSettings,
} from './task-config';

const settings = (over: Partial<TaskSettings>): TaskSettings => ({
  kind: 'GENERAL',
  buttons: ['ACKNOWLEDGE', 'COMPLETE'],
  reportRequired: false,
  approvalMode: 'MANUAL',
  ...over,
});

describe('task configuration', () => {
  it('derives how a recipient completes from the buttons and the report', () => {
    expect(completionMethod(settings({}))).toBe('BUTTON');
    expect(completionMethod(settings({ buttons: ['ACKNOWLEDGE'], reportRequired: true }))).toBe(
      'REPORT',
    );
    expect(completionMethod(settings({ buttons: ['ACKNOWLEDGE'] }))).toBe('ACKNOWLEDGE');
  });

  it('refuses a task nobody could act on', () => {
    const refused = validateSettings(settings({ buttons: [], reportRequired: false }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('tasks.no_way_to_respond');
    expect(validateSettings(settings({ buttons: [], reportRequired: true })).ok).toBe(true);
  });

  it('classifies reports by the task kind, never by the employee', () => {
    expect(reportCategoryOf('GENERAL')).toBe('TASK_COMPLETION');
    expect(reportCategoryOf('ATTENDANCE')).toBe('ATTENDANCE');
    expect(reportCategoryOf('TEACHING')).toBe('TEACHERS');
  });

  it('keeps known buttons once, in canonical order, and refuses an unknown one', () => {
    expect(normaliseButtons(['COMPLETE', 'ACKNOWLEDGE', 'COMPLETE'])).toEqual([
      'ACKNOWLEDGE',
      'COMPLETE',
    ]);
    expect(normaliseButtons(['APPLAUD'])).toBeNull();
  });

  it('trims content and bounds it', () => {
    const ok = normaliseContent('  تحضير  ', '  نص  ');
    expect(ok).toEqual({ ok: true, value: { title: 'تحضير', body: 'نص' } });
    const blank = normaliseContent('   ', 'x');
    expect(!blank.ok && blank.error.code).toBe('tasks.title_required');
    const long = normaliseContent('ت'.repeat(201), '');
    expect(!long.ok && long.error.code).toBe('tasks.title_too_long');
  });
});
