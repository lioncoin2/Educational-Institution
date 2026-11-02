import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or } from 'drizzle-orm';

import { DATABASE, type Database } from '../../../platform/database';
import type { TemplateRepository } from '../domain/ports';
import type { TaskTemplate } from '../domain/template';
import { toTemplate } from './row-mapping';
import { tasksTemplates } from './schema';

/** Saved task configurations on Postgres (roadmap §10). */
@Injectable()
export class DrizzleTemplateRepository implements TemplateRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(template: TaskTemplate): Promise<void> {
    await this.db.insert(tasksTemplates).values({
      ...template,
      buttons: [...template.buttons],
      audiences: [...template.audiences],
    });
  }

  async findById(id: string): Promise<TaskTemplate | null> {
    const [row] = await this.db.select().from(tasksTemplates).where(eq(tasksTemplates.id, id));
    return row === undefined ? null : toTemplate(row);
  }

  async list(
    after: { readonly createdAt: Date; readonly id: string } | null,
    limit: number,
  ): Promise<readonly TaskTemplate[]> {
    const rows = await this.db
      .select()
      .from(tasksTemplates)
      .where(
        after === null
          ? undefined
          : or(
              lt(tasksTemplates.createdAt, after.createdAt),
              and(eq(tasksTemplates.createdAt, after.createdAt), lt(tasksTemplates.id, after.id)),
            ),
      )
      .orderBy(desc(tasksTemplates.createdAt), desc(tasksTemplates.id))
      .limit(limit);
    return rows.map(toTemplate);
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(tasksTemplates)
      .where(eq(tasksTemplates.id, id))
      .returning({ id: tasksTemplates.id });
    return deleted.length > 0;
  }
}
