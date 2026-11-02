import type { Person } from './tasks-harness';

/**
 * The institution the tasks suites run in: an owner, two administrators, three
 * teachers (one an assistant), a supervisor, a student, and a teacher whose
 * account is suspended — and one group (community) with a teacher, the
 * supervisor and the student in it.
 */
export const STAFF: readonly Person[] = [
  { id: 'owner', roles: ['OWNER'] },
  { id: 'admin-1', roles: ['ADMIN'] },
  { id: 'admin-2', roles: ['ADMIN'] },
  { id: 'teacher-1', roles: ['TEACHER'] },
  { id: 'teacher-2', roles: ['TEACHER'] },
  { id: 'assistant-1', roles: ['ASSISTANT_TEACHER'] },
  { id: 'supervisor-1', roles: ['SUPERVISOR'] },
  { id: 'student-1', roles: ['STUDENT'] },
  { id: 'teacher-off', roles: ['TEACHER'], active: false },
];

export const GROUPS: Readonly<Record<string, readonly string[]>> = {
  'group-1': ['teacher-1', 'supervisor-1', 'student-1'],
};

/** A publishable draft; each test overrides what it is about. */
export function draft(over: Record<string, unknown> = {}) {
  return {
    title: 'تحضير درس الغد',
    body: 'اكتبي خطة الدرس',
    kind: 'GENERAL',
    buttons: ['ACKNOWLEDGE', 'COMPLETE'],
    reportRequired: false,
    approvalMode: 'MANUAL',
    audiences: ['TEACHERS'],
    ...over,
  };
}

/** The value of an ok Result, or the test fails with the refusal's code. */
export function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

/** The refusal code of a Result, or null when it succeeded. */
export function codeOf(result: { ok: boolean; error?: { code: string } }): string | null {
  return result.ok ? null : (result.error?.code ?? null);
}
