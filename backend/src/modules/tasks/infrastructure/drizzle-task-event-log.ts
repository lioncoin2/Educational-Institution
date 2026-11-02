import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { TaskEventLog } from '../domain/ports';
import type { TaskEventEntry, TaskEventRecord } from '../domain/task-event';
import { insertEvents } from './event-rows';
import { toEventEntry } from './row-mapping';
import { tasksEvents } from './schema';

/** The operation log on Postgres — append for acts that write nothing else, and read. */
@Injectable()
export class DrizzleTaskEventLog implements TaskEventLog {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async append(event: TaskEventRecord): Promise<void> {
    await insertEvents(this.db, [event]);
  }

  async list(
    taskId: string,
    afterSequence: number | null,
    limit: number,
  ): Promise<readonly TaskEventEntry[]> {
    const rows = await this.db
      .select()
      .from(tasksEvents)
      .where(
        and(
          eq(tasksEvents.taskId, taskId),
          afterSequence === null ? undefined : gt(tasksEvents.sequence, afterSequence),
        ),
      )
      .orderBy(asc(tasksEvents.sequence))
      .limit(limit);
    return rows.map(toEventEntry);
  }
}
