import { Inject, Injectable } from '@nestjs/common';

import { err, type Principal, type Result } from '../../../../shared';
import { TASK_REPOSITORY, type PublishOutcome, type TaskRepository } from '../../domain/ports';
import { optionalId, parseAudiences, parseDraft } from '../task-draft';
import { TASK_NOT_FOUND } from '../task-failures';
import { TaskPublisher } from '../task-publisher';
import { TasksAccess } from '../tasks-access';

export interface RepublishTaskCommand {
  readonly principal: Principal;
  readonly taskId: string;
  /** Changes made before re-publishing; absent fields keep the earlier task's. */
  readonly title?: string;
  readonly body?: string;
  readonly kind?: string;
  readonly buttons?: readonly string[];
  readonly reportRequired?: boolean;
  readonly approvalMode?: string;
  readonly audiences?: readonly string[];
  readonly communityId?: string | null;
  readonly clientRequestId?: string | null;
}

/**
 * Re-publish a past task (roadmap §10): a completely new task — new id, new
 * addressees resolved now, new responses and reports, its own follow-up — that
 * only remembers which task it came from. The owner's.
 */
@Injectable()
export class RepublishTaskUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    private readonly publisher: TaskPublisher,
  ) {}

  async execute(command: RepublishTaskCommand): Promise<Result<PublishOutcome>> {
    const allowed = this.access.authorizeTemplate(command.principal);
    if (!allowed.ok) return allowed;
    const source = await this.tasks.findById(command.taskId);
    if (source === null) return err(TASK_NOT_FOUND);
    const draft = parseDraft({
      title: command.title ?? source.title,
      body: command.body ?? source.body,
      kind: command.kind ?? source.kind,
      buttons: command.buttons ?? source.buttons,
      reportRequired: command.reportRequired ?? source.reportRequired,
      approvalMode: command.approvalMode ?? source.approvalMode,
    });
    if (!draft.ok) return draft;
    const audiences = parseAudiences(command.audiences ?? source.audiences);
    if (!audiences.ok) return audiences;
    return this.publisher.publish({
      principal: command.principal,
      draft: draft.value,
      audiences: audiences.value,
      communityId:
        command.communityId === undefined ? source.communityId : optionalId(command.communityId),
      templateId: null,
      republishedFrom: source.id,
      clientRequestId: optionalId(command.clientRequestId),
    });
  }
}
