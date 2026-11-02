import { Inject, Injectable } from '@nestjs/common';

import { err, ok, type Principal, type Result } from '../../../../shared';
import type { Assignment } from '../../domain/assignment';
import {
  ASSIGNMENT_REPOSITORY,
  TASK_REPOSITORY,
  type AssignmentRepository,
  type TaskRepository,
} from '../../domain/ports';
import type { Task } from '../../domain/task';
import { ASSIGNMENT_NOT_FOUND } from '../task-failures';
import { TasksAccess } from '../tasks-access';

export interface OwnTask {
  readonly assignment: Assignment;
  readonly task: Task;
}

/**
 * A recipient's own assignment and its task, or one refusal: the `respond`
 * permission, then ownership — someone else's assignment reads as non-existent.
 */
@Injectable()
export class OwnTaskLoader {
  constructor(
    private readonly access: TasksAccess,
    @Inject(ASSIGNMENT_REPOSITORY) private readonly assignments: AssignmentRepository,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
  ) {}

  async load(principal: Principal, assignmentId: string): Promise<Result<OwnTask>> {
    const allowed = this.access.authorizeRespond(principal);
    if (!allowed.ok) return allowed;
    const own = this.access.ownAssignment(principal, await this.assignments.findById(assignmentId));
    if (!own.ok) return own;
    const task = await this.tasks.findById(own.value.taskId);
    if (task === null) return err(ASSIGNMENT_NOT_FOUND);
    return ok({ assignment: own.value, task });
  }
}
