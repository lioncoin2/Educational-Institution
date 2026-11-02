import { and, eq, gte, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { TaskFilter } from '../domain/read-ports';
import { tasks, tasksAssignments } from './schema';

/**
 * The common filters (ADR 0052 §12) as SQL. Task-level conditions select tasks;
 * the dashboard narrows the counted assignments too (an audience or a person is
 * about who was asked, not only which task).
 */

/** A literal, case-insensitive match: LIKE metacharacters in the text are escaped. */
function containsText(text: string): SQL {
  const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return sql`(${tasks.title} ilike ${pattern} or ${tasks.body} ilike ${pattern})`;
}

export function taskConditions(filter: TaskFilter): SQL | undefined {
  const text = filter.text?.trim() ?? '';
  return and(
    filter.from === undefined ? undefined : gte(tasks.createdAt, filter.from),
    filter.to === undefined ? undefined : lt(tasks.createdAt, filter.to),
    filter.audience === undefined
      ? undefined
      : sql`${tasks.audiences} @> ${JSON.stringify([filter.audience])}::jsonb`,
    filter.communityId === undefined ? undefined : eq(tasks.communityId, filter.communityId),
    filter.kind === undefined ? undefined : eq(tasks.kind, filter.kind),
    stateCondition(filter.state),
    filter.personId === undefined
      ? undefined
      : sql`exists (select 1 from tasks_assignments pa
                    where pa.task_id = ${tasks.id} and pa.recipient_id = ${filter.personId})`,
    filter.reportStatus === undefined
      ? undefined
      : sql`exists (select 1 from tasks_reports pr
                    where pr.task_id = ${tasks.id} and pr.status = ${filter.reportStatus})`,
    text === '' ? undefined : containsText(text),
  );
}

/** Narrows the counted assignments to the filtered audience and person. */
export function assignmentConditions(filter: TaskFilter): SQL | undefined {
  return and(
    filter.audience === undefined ? undefined : eq(tasksAssignments.audience, filter.audience),
    filter.personId === undefined ? undefined : eq(tasksAssignments.recipientId, filter.personId),
  );
}

function stateCondition(state: TaskFilter['state']): SQL | undefined {
  switch (state) {
    case undefined:
      return undefined;
    case 'ACTIVE':
      return and(eq(tasks.status, 'OPEN'), isNull(tasks.archivedAt));
    case 'ARCHIVED':
      return and(eq(tasks.status, 'OPEN'), isNotNull(tasks.archivedAt));
    case 'CANCELLED':
      return eq(tasks.status, 'CANCELLED');
  }
}

/** Newest-first keyset on (column, id). */
export function newestAfter(
  column: AnyPgColumn,
  idColumn: AnyPgColumn,
  after: { readonly at: Date; readonly id: string } | null,
): SQL | undefined {
  if (after === null) return undefined;
  return or(lt(column, after.at), and(eq(column, after.at), lt(idColumn, after.id)));
}
