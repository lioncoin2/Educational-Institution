import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * The tasks engine's tables (ADR 0052 §3). One table per concept; account and
 * community ids are opaque text (no cross-module foreign keys); in-module
 * foreign keys are RESTRICT — nothing here is ever hard-deleted except a
 * template. CHECKs mirror the domain vocabularies; unique indexes settle races.
 */

const KINDS = sql`('GENERAL', 'ATTENDANCE', 'TEACHING')`;
const MODES = sql`('AUTO', 'MANUAL')`;
const ts = (name: string) => timestamp(name, { withTimezone: true });

/** The configuration shared by a template, a task and a task revision. */
const configuration = () => ({
  title: text('title').notNull(),
  body: text('body').notNull(),
  kind: text('kind').notNull(),
  buttons: jsonb('buttons').$type<string[]>().notNull(),
  reportRequired: boolean('report_required').notNull(),
  approvalMode: text('approval_mode').notNull(),
});

export const tasksTemplates = pgTable(
  'tasks_templates',
  {
    id: text('id').primaryKey(),
    ...configuration(),
    audiences: jsonb('audiences').$type<string[]>().notNull(),
    communityId: text('community_id'),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    check('tasks_templates_kind_valid', sql`${t.kind} in ${KINDS}`),
    check('tasks_templates_mode_valid', sql`${t.approvalMode} in ${MODES}`),
    index('tasks_templates_newest').on(t.createdAt, t.id),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    ...configuration(),
    audiences: jsonb('audiences').$type<string[]>().notNull(),
    communityId: text('community_id'),
    revision: integer('revision').notNull(),
    status: text('status').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    cancelledAt: ts('cancelled_at'),
    cancelledBy: text('cancelled_by'),
    archivedAt: ts('archived_at'),
    templateId: text('template_id'),
    republishedFrom: text('republished_from'),
    clientRequestId: text('client_request_id'),
  },
  (t) => [
    check('tasks_status_valid', sql`${t.status} in ('OPEN', 'CANCELLED')`),
    check('tasks_kind_valid', sql`${t.kind} in ${KINDS}`),
    check('tasks_mode_valid', sql`${t.approvalMode} in ${MODES}`),
    check('tasks_revision_positive', sql`${t.revision} >= 1`),
    check('tasks_title_length', sql`char_length(${t.title}) between 1 and 200`),
    check('tasks_audiences_array', sql`jsonb_typeof(${t.audiences}) = 'array'`),
    check('tasks_buttons_array', sql`jsonb_typeof(${t.buttons}) = 'array'`),
    // CANCELLED iff both cancellation stamps are set; a cancelled task is archived.
    check(
      'tasks_cancelled_consistent',
      sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} is not null and ${t.cancelledBy} is not null)
          and (${t.status} <> 'CANCELLED' or ${t.archivedAt} is not null)`,
    ),
    index('tasks_newest').on(t.createdAt, t.id),
    index('tasks_by_community').on(t.communityId, t.createdAt),
    uniqueIndex('tasks_client_request_unique')
      .on(t.createdBy, t.clientRequestId)
      .where(sql`${t.clientRequestId} is not null`),
  ],
);

export const tasksRevisions = pgTable(
  'tasks_revisions',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    ...configuration(),
    editedBy: text('edited_by').notNull(),
    editedAt: ts('edited_at').notNull(),
    requireReacknowledge: boolean('require_reacknowledge').notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.revision] })],
);

export const tasksAssignments = pgTable(
  'tasks_assignments',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    recipientId: text('recipient_id').notNull(),
    audience: text('audience').notNull(),
    status: text('status').notNull(),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedRevision: integer('acknowledged_revision'),
    completedAt: ts('completed_at'),
    createdAt: ts('created_at').notNull(),
    reassignedTo: text('reassigned_to'),
    reassignedAt: ts('reassigned_at'),
    reassignedBy: text('reassigned_by'),
    replaces: text('replaces'),
  },
  (t) => [
    check(
      'tasks_assignments_status_valid',
      sql`${t.status} in ('PENDING', 'ACKNOWLEDGED', 'COMPLETED', 'REASSIGNED')`,
    ),
    check(
      'tasks_assignments_audience_valid',
      sql`${t.audience} in ('TEACHERS', 'SUPERVISORS', 'ADMINISTRATION')`,
    ),
    check(
      'tasks_assignments_completed_consistent',
      sql`(${t.status} = 'COMPLETED') = (${t.completedAt} is not null) or ${t.status} = 'REASSIGNED'`,
    ),
    check(
      'tasks_assignments_reassigned_consistent',
      sql`(${t.status} = 'REASSIGNED') = (${t.reassignedTo} is not null and ${t.reassignedAt} is not null)`,
    ),
    // One person holds a task at most once at a time.
    uniqueIndex('tasks_assignments_one_open_per_person')
      .on(t.taskId, t.recipientId)
      .where(sql`${t.status} <> 'REASSIGNED'`),
    index('tasks_assignments_by_task').on(t.taskId, t.createdAt, t.id),
    index('tasks_assignments_by_recipient').on(t.recipientId, t.createdAt, t.id),
  ],
);

export const tasksReports = pgTable(
  'tasks_reports',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    assignmentId: text('assignment_id')
      .notNull()
      .references(() => tasksAssignments.id, { onDelete: 'restrict' }),
    authorId: text('author_id').notNull(),
    category: text('category').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    submittedAt: ts('submitted_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    approvedAt: ts('approved_at'),
    approvedBy: text('approved_by'),
    deletedAt: ts('deleted_at'),
    deletedBy: text('deleted_by'),
  },
  (t) => [
    check(
      'tasks_reports_status_valid',
      sql`${t.status} in ('PENDING_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'DELETED')`,
    ),
    check(
      'tasks_reports_category_valid',
      sql`${t.category} in ('TASK_COMPLETION', 'ATTENDANCE', 'TEACHERS')`,
    ),
    check('tasks_reports_version_positive', sql`${t.version} >= 1`),
    check(
      'tasks_reports_approved_consistent',
      sql`(${t.status} = 'APPROVED') = (${t.approvedAt} is not null)`,
    ),
    check(
      'tasks_reports_deleted_consistent',
      sql`(${t.status} = 'DELETED') = (${t.deletedAt} is not null and ${t.deletedBy} is not null)`,
    ),
    uniqueIndex('tasks_reports_one_per_assignment').on(t.assignmentId),
    index('tasks_reports_recent').on(t.updatedAt, t.id),
    index('tasks_reports_by_task').on(t.taskId),
  ],
);

export const tasksReportVersions = pgTable(
  'tasks_report_versions',
  {
    reportId: text('report_id')
      .notNull()
      .references(() => tasksReports.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    editedBy: text('edited_by').notNull(),
    editedAt: ts('edited_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.version] }),
    check('tasks_report_versions_body_length', sql`char_length(${t.body}) between 1 and 20000`),
  ],
);

export const tasksReportReviews = pgTable(
  'tasks_report_reviews',
  {
    id: text('id').primaryKey(),
    reportId: text('report_id')
      .notNull()
      .references(() => tasksReports.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    decision: text('decision').notNull(),
    note: text('note'),
    reviewerId: text('reviewer_id').notNull(),
    decidedAt: ts('decided_at').notNull(),
  },
  (t) => [
    check(
      'tasks_report_reviews_decision_valid',
      sql`${t.decision} in ('APPROVED', 'CHANGES_REQUESTED')`,
    ),
    index('tasks_report_reviews_by_report').on(t.reportId, t.decidedAt),
  ],
);

export const tasksEvents = pgTable(
  'tasks_events',
  {
    sequence: bigserial('sequence', { mode: 'number' }).primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    actorId: text('actor_id'),
    assignmentId: text('assignment_id'),
    reportId: text('report_id'),
    detail: jsonb('detail').$type<Record<string, string | number | boolean | null>>().notNull(),
    occurredAt: ts('occurred_at').notNull(),
  },
  (t) => [
    check('tasks_events_action_shape', sql`${t.action} ~ '^[A-Z][A-Z_]{0,63}$'`),
    check('tasks_events_detail_object', sql`jsonb_typeof(${t.detail}) = 'object'`),
    index('tasks_events_by_task').on(t.taskId, t.sequence),
  ],
);
