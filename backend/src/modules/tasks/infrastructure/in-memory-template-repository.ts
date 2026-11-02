import { Injectable } from '@nestjs/common';

import type { TemplateRepository } from '../domain/ports';
import type { TaskTemplate } from '../domain/template';
import { InMemoryTasksState } from './in-memory-tasks-state';
import { isAfter, newestFirst } from './task-filter-match';

/** Saved task configurations in memory. */
@Injectable()
export class InMemoryTemplateRepository implements TemplateRepository {
  constructor(private readonly state: InMemoryTasksState) {}

  async create(template: TaskTemplate): Promise<void> {
    this.state.templates.set(template.id, template);
  }

  async findById(id: string): Promise<TaskTemplate | null> {
    return this.state.templates.get(id) ?? null;
  }

  async list(
    after: { readonly createdAt: Date; readonly id: string } | null,
    limit: number,
  ): Promise<readonly TaskTemplate[]> {
    const key = (t: TaskTemplate) => ({ at: t.createdAt, id: t.id });
    return [...this.state.templates.values()]
      .sort(newestFirst(key))
      .filter((t) => isAfter(key(t), after && { at: after.createdAt, id: after.id }))
      .slice(0, limit);
  }

  async delete(id: string): Promise<boolean> {
    return this.state.templates.delete(id);
  }
}
