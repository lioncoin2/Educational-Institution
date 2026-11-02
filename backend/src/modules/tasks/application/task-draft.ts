import { err, ok, type Result } from '../../../shared';
import { normaliseAudiences, type TaskAudience } from '../domain/audience';
import {
  isApprovalMode,
  isTaskKind,
  normaliseButtons,
  normaliseContent,
  validateSettings,
  type TaskContent,
  type TaskSettings,
} from '../domain/task-config';
import { AUDIENCE_INVALID, SETTINGS_INVALID } from './task-failures';

/** A task as typed by the publisher — raw codes, not yet trusted. */
export interface RawTaskDraft {
  readonly title: string;
  readonly body: string;
  readonly kind: string;
  readonly buttons: readonly string[];
  readonly reportRequired: boolean;
  readonly approvalMode: string;
}

export interface TaskDraft {
  readonly content: TaskContent;
  readonly settings: TaskSettings;
}

/** Raw content and settings → validated domain values (ADR 0052 §4). */
export function parseDraft(raw: RawTaskDraft): Result<TaskDraft> {
  const content = normaliseContent(raw.title, raw.body);
  if (!content.ok) return content;
  const buttons = normaliseButtons(raw.buttons);
  if (buttons === null || !isTaskKind(raw.kind) || !isApprovalMode(raw.approvalMode)) {
    return err(SETTINGS_INVALID);
  }
  const settings = validateSettings({
    kind: raw.kind,
    buttons,
    reportRequired: raw.reportRequired,
    approvalMode: raw.approvalMode,
  });
  if (!settings.ok) return settings;
  return ok({ content: content.value, settings: settings.value });
}

export function parseAudiences(raw: readonly string[]): Result<readonly TaskAudience[]> {
  const audiences = normaliseAudiences(raw);
  return audiences === null ? err(AUDIENCE_INVALID) : ok(audiences);
}

/** A blank optional id is absent. */
export function optionalId(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}
