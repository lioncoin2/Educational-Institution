import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  domainEvent,
  err,
  ok,
  type Clock,
  type Principal,
  type Result,
} from '../../../../shared';
import { TasksEvents } from '../../contracts';
import {
  ASSIGNMENT_REPOSITORY,
  TASK_REPOSITORY,
  type AssignmentRepository,
  type TaskRepository,
} from '../../domain/ports';
import { TASK_READ_MODEL, type TaskReadModel } from '../../domain/read-ports';
import { applyEdit, isActive, type Task, type TaskRevision } from '../../domain/task';
import { sameSettings } from '../../domain/task-config';
import { logEntry } from '../operation-log';
import { parseDraft } from '../task-draft';
import {
  REVISION_CONFLICT,
  SETTINGS_LOCKED,
  TASK_NOT_ACTIVE,
  TASK_NOT_FOUND,
} from '../task-failures';
import { TasksAccess } from '../tasks-access';
import { TasksJournal } from '../tasks-journal';

export interface EditTaskCommand {
  readonly principal: Principal;
  readonly taskId: string;
  /** The revision the editor read; a newer stored one is a conflict. */
  readonly revision: number;
  readonly title?: string;
  readonly body?: string;
  readonly kind?: string;
  readonly buttons?: readonly string[];
  readonly reportRequired?: boolean;
  readonly approvalMode?: string;
  /** Ask every addressee who has not completed to acknowledge again (roadmap §8). */
  readonly requireReacknowledge?: boolean;
}

/**
 * Edit a published task (ADR 0052 §7): a new revision, responses kept, the
 * addressees told. Any member of the administration may edit any task.
 */
@Injectable()
export class EditTaskUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepository,
    @Inject(TASK_READ_MODEL) private readonly reads: TaskReadModel,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: EditTaskCommand): Promise<Result<Task>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const task = await this.tasks.findById(command.taskId);
    if (task === null) return err(TASK_NOT_FOUND);
    if (!isActive(task)) return err(TASK_NOT_ACTIVE);
    if (task.revision !== command.revision) return err(REVISION_CONFLICT);

    const draft = parseDraft({
      title: command.title ?? task.title,
      body: command.body ?? task.body,
      kind: command.kind ?? task.kind,
      buttons: command.buttons ?? task.buttons,
      reportRequired: command.reportRequired ?? task.reportRequired,
      approvalMode: command.approvalMode ?? task.approvalMode,
    });
    if (!draft.ok) return draft;
    if (
      !sameSettings(task, draft.value.settings) &&
      (await this.reads.countsOf(task.id)).responded > 0
    ) {
      return err(SETTINGS_LOCKED);
    }

    const now = this.clock.now();
    const actorId = command.principal.userId;
    const reacknowledge = command.requireReacknowledge === true;
    const next = applyEdit(task, { ...draft.value.content, ...draft.value.settings }, now);
    const revision: TaskRevision = {
      taskId: task.id,
      revision: next.revision,
      ...draft.value.content,
      ...draft.value.settings,
      editedBy: actorId,
      editedAt: now,
      requireReacknowledge: reacknowledge,
    };
    const saved = await this.tasks.edit(
      next,
      revision,
      logEntry('TASK_EDITED', task.id, actorId, now, {
        detail: { revision: next.revision, requireReacknowledge: reacknowledge },
      }),
    );
    if (saved === 'stale') return err(REVISION_CONFLICT);

    const concerned = await this.assignments.openNotCompleted(task.id);
    await this.journal.record(
      {
        actorUserId: actorId,
        action: 'tasks.task.edited',
        resourceType: 'task',
        resourceId: task.id,
        at: now,
        metadata: { revision: next.revision, requireReacknowledge: reacknowledge },
      },
      [
        domainEvent(
          TasksEvents.updated,
          task.id,
          { taskId: task.id, actorId, recipientUserIds: concerned.map((a) => a.recipientId) },
          now,
        ),
      ],
    );
    return ok(next);
  }
}
