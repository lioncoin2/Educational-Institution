import { Injectable } from '@nestjs/common';

import type { TaskEventLog } from '../domain/ports';
import type { TaskEventEntry, TaskEventRecord } from '../domain/task-event';
import { InMemoryTasksState } from './in-memory-tasks-state';

/** The operation log in memory. */
@Injectable()
export class InMemoryTaskEventLog implements TaskEventLog {
  constructor(private readonly state: InMemoryTasksState) {}

  async append(event: TaskEventRecord): Promise<void> {
    this.state.appendEvents([event]);
  }

  async list(
    taskId: string,
    afterSequence: number | null,
    limit: number,
  ): Promise<readonly TaskEventEntry[]> {
    return this.state.events
      .filter((e) => e.taskId === taskId && (afterSequence === null || e.sequence > afterSequence))
      .slice(0, limit);
  }
}
