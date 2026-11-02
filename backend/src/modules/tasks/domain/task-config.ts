import { err, failure, ok, type Result } from '../../../shared';

/**
 * A task's configuration — what the publisher chooses, and the pure rules that
 * follow from it (ADR 0052 §4, §6; roadmap §3, §5, §6).
 */

/**
 * The interactive buttons a recipient may be shown. Stored as a list so a new
 * kind can be added later without remodelling (roadmap §3).
 */
export const TASK_BUTTONS = ['ACKNOWLEDGE', 'COMPLETE'] as const;
export type TaskButton = (typeof TASK_BUTTONS)[number];

/** What the task is about — chosen by the publisher; it decides the report category. */
export const TASK_KINDS = ['GENERAL', 'ATTENDANCE', 'TEACHING'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** How a submitted report is treated: approved at once, or held for the administration. */
export const APPROVAL_MODES = ['AUTO', 'MANUAL'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Where reports land on the reports page — derived, never chosen by the employee. */
export const REPORT_CATEGORIES = ['TASK_COMPLETION', 'ATTENDANCE', 'TEACHERS'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * How a recipient finishes a task:
 *   BUTTON       the complete button (carrying the report when one is required)
 *   REPORT       submitting the required report (no complete button)
 *   ACKNOWLEDGE  acknowledging (no complete button, no report)
 */
export type CompletionMethod = 'BUTTON' | 'REPORT' | 'ACKNOWLEDGE';

export const TASK_TITLE_MAX = 200;
export const TASK_BODY_MAX = 10_000;

export interface TaskContent {
  readonly title: string;
  readonly body: string;
}

export interface TaskSettings {
  readonly kind: TaskKind;
  readonly buttons: readonly TaskButton[];
  readonly reportRequired: boolean;
  readonly approvalMode: ApprovalMode;
}

const CATEGORY_BY_KIND: Readonly<Record<TaskKind, ReportCategory>> = Object.freeze({
  GENERAL: 'TASK_COMPLETION',
  ATTENDANCE: 'ATTENDANCE',
  TEACHING: 'TEACHERS',
});

/** The category every report of a task of this kind belongs to (ADR 0052 §6). */
export function reportCategoryOf(kind: TaskKind): ReportCategory {
  return CATEGORY_BY_KIND[kind];
}

export function completionMethod(settings: TaskSettings): CompletionMethod {
  if (settings.buttons.includes('COMPLETE')) return 'BUTTON';
  if (settings.reportRequired) return 'REPORT';
  return 'ACKNOWLEDGE';
}

export function isTaskKind(value: string): value is TaskKind {
  return (TASK_KINDS as readonly string[]).includes(value);
}

export function isApprovalMode(value: string): value is ApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(value);
}

/** Known buttons only, without duplicates, in canonical order; null on an unknown one. */
export function normaliseButtons(values: readonly string[]): readonly TaskButton[] | null {
  if (!values.every((value) => (TASK_BUTTONS as readonly string[]).includes(value))) return null;
  const wanted = new Set<string>(values);
  return TASK_BUTTONS.filter((button) => wanted.has(button));
}

/**
 * The settings a task may be published or edited with. A task with no button
 * and no report could never be acted on, so it is refused.
 */
export function validateSettings(settings: TaskSettings): Result<TaskSettings> {
  if (settings.buttons.length === 0 && !settings.reportRequired) {
    return err(
      failure(
        'validation',
        'tasks.no_way_to_respond',
        'A task needs at least one button or a required report.',
      ),
    );
  }
  return ok(settings);
}

/** Trimmed title and body within their bounds; a blank title is refused. */
export function normaliseContent(title: string, body: string): Result<TaskContent> {
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (trimmedTitle === '') {
    return err(failure('validation', 'tasks.title_required', 'A task needs a title.'));
  }
  if ([...trimmedTitle].length > TASK_TITLE_MAX) {
    return err(
      failure('validation', 'tasks.title_too_long', `A title may be at most ${TASK_TITLE_MAX}.`, {
        max: TASK_TITLE_MAX,
      }),
    );
  }
  if ([...trimmedBody].length > TASK_BODY_MAX) {
    return err(
      failure(
        'validation',
        'tasks.body_too_long',
        `Instructions may be at most ${TASK_BODY_MAX}.`,
        {
          max: TASK_BODY_MAX,
        },
      ),
    );
  }
  return ok({ title: trimmedTitle, body: trimmedBody });
}

/** Whether two configurations would complete and review the same way. */
export function sameSettings(a: TaskSettings, b: TaskSettings): boolean {
  return (
    a.reportRequired === b.reportRequired &&
    a.approvalMode === b.approvalMode &&
    a.buttons.length === b.buttons.length &&
    a.buttons.every((button, index) => b.buttons[index] === button)
  );
}
