import { Inject, Injectable } from '@nestjs/common';

import {
  clampLimit,
  CLOCK,
  err,
  ID_GENERATOR,
  ok,
  type Clock,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../../shared';
import {
  TASK_REPOSITORY,
  TEMPLATE_REPOSITORY,
  type TaskRepository,
  type TemplateRepository,
} from '../../domain/ports';
import type { TaskTemplate } from '../../domain/template';
import { decodeInstantCursor, encodeInstantCursor, page } from '../cursors';
import { optionalId, parseAudiences, parseDraft, type RawTaskDraft } from '../task-draft';
import { TASK_NOT_FOUND, TEMPLATE_NOT_FOUND } from '../task-failures';
import { TasksAccess } from '../tasks-access';
import { TasksJournal } from '../tasks-journal';

export interface SaveTemplateCommand {
  readonly principal: Principal;
  /** Save an existing task's configuration… */
  readonly fromTaskId?: string | null;
  /** …or one typed here. */
  readonly draft?: RawTaskDraft & {
    readonly audiences: readonly string[];
    readonly communityId?: string | null;
  };
}

/** Save a task configuration for reuse (roadmap §10) — never its responses. The owner's. */
@Injectable()
export class SaveTemplateUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: SaveTemplateCommand): Promise<Result<TaskTemplate>> {
    const allowed = this.access.authorizeTemplate(command.principal);
    if (!allowed.ok) return allowed;
    const source = await this.source(command);
    if (!source.ok) return source;
    const now = this.clock.now();
    const template: TaskTemplate = {
      id: this.ids.next<'TaskTemplate'>(),
      ...source.value,
      createdBy: command.principal.userId,
      createdAt: now,
    };
    await this.templates.create(template);
    await this.journal.record({
      actorUserId: command.principal.userId,
      action: 'tasks.template.saved',
      resourceType: 'task_template',
      resourceId: template.id,
      at: now,
    });
    return ok(template);
  }

  private async source(
    command: SaveTemplateCommand,
  ): Promise<Result<Omit<TaskTemplate, 'id' | 'createdBy' | 'createdAt'>>> {
    const fromTaskId = optionalId(command.fromTaskId);
    if (fromTaskId !== null) {
      const task = await this.tasks.findById(fromTaskId);
      if (task === null) return err(TASK_NOT_FOUND);
      const { title, body, kind, buttons, reportRequired, approvalMode, audiences, communityId } =
        task;
      return ok({
        title,
        body,
        kind,
        buttons,
        reportRequired,
        approvalMode,
        audiences,
        communityId,
      });
    }
    const raw = command.draft;
    const draft = parseDraft(
      raw ?? {
        title: '',
        body: '',
        kind: '',
        buttons: [],
        reportRequired: false,
        approvalMode: '',
      },
    );
    if (!draft.ok) return draft;
    const audiences = parseAudiences(raw?.audiences ?? []);
    if (!audiences.ok) return audiences;
    return ok({
      ...draft.value.content,
      ...draft.value.settings,
      audiences: audiences.value,
      communityId: optionalId(raw?.communityId),
    });
  }
}

/** The saved templates, newest first. Readable by whoever may publish. */
@Injectable()
export class ListTemplatesUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<{ readonly items: readonly TaskTemplate[]; readonly nextCursor?: string }>> {
    const allowed = this.access.authorizeManage(command.principal);
    if (!allowed.ok) return allowed;
    const after = decodeInstantCursor(command.cursor);
    if (!after.ok) return after;
    const limit = clampLimit(command.limit);
    const rows = await this.templates.list(
      after.value && { createdAt: after.value.at, id: after.value.id },
      limit + 1,
    );
    return ok(
      page(rows, limit, (last) => encodeInstantCursor({ at: last.createdAt, id: last.id })),
    );
  }
}

/** Remove a template; tasks published from it keep their provenance id. The owner's. */
@Injectable()
export class DeleteTemplateUseCase {
  constructor(
    private readonly access: TasksAccess,
    @Inject(TEMPLATE_REPOSITORY) private readonly templates: TemplateRepository,
    private readonly journal: TasksJournal,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly templateId: string;
  }): Promise<Result<void>> {
    const allowed = this.access.authorizeTemplate(command.principal);
    if (!allowed.ok) return allowed;
    if (!(await this.templates.delete(command.templateId))) return err(TEMPLATE_NOT_FOUND);
    await this.journal.record({
      actorUserId: command.principal.userId,
      action: 'tasks.template.deleted',
      resourceType: 'task_template',
      resourceId: command.templateId,
      at: this.clock.now(),
    });
    return ok(undefined);
  }
}
