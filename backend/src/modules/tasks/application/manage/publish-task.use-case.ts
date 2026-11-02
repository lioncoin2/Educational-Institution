import { Inject, Injectable } from '@nestjs/common';

import { err, type Principal, type Result } from '../../../../shared';
import type { PublishOutcome } from '../../domain/ports';
import { TEMPLATE_REPOSITORY, type TemplateRepository } from '../../domain/ports';
import { optionalId, parseAudiences, parseDraft, type RawTaskDraft } from '../task-draft';
import { TEMPLATE_NOT_FOUND } from '../task-failures';
import { TaskPublisher } from '../task-publisher';
import { TasksAccess } from '../tasks-access';

export interface PublishTaskCommand extends RawTaskDraft {
  readonly principal: Principal;
  readonly audiences: readonly string[];
  readonly communityId?: string | null;
  /** The template the publisher started from, if any — provenance only. */
  readonly templateId?: string | null;
  /** Idempotency key: a retried publish returns the first task. */
  readonly clientRequestId?: string | null;
}

/** Publish a new task to one or more staff audiences (roadmap §2–§3). OWNER/ADMIN. */
@Injectable()
export class PublishTaskUseCase {
  constructor(
    private readonly access: TasksAccess,
    private readonly publisher: TaskPublisher,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
  ) {}

  async execute(command: PublishTaskCommand): Promise<Result<PublishOutcome>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const draft = parseDraft(command);
    if (!draft.ok) return draft;
    const audiences = parseAudiences(command.audiences);
    if (!audiences.ok) return audiences;
    const templateId = optionalId(command.templateId);
    if (templateId !== null && (await this.templates.findById(templateId)) === null) {
      return err(TEMPLATE_NOT_FOUND);
    }
    return this.publisher.publish({
      principal: command.principal,
      draft: draft.value,
      audiences: audiences.value,
      communityId: optionalId(command.communityId),
      templateId,
      republishedFrom: null,
      clientRequestId: optionalId(command.clientRequestId),
    });
  }
}
