-- Daily tasks & reports engine (ADR 0052), step 1 of 2: schema.
--
-- Eight tables private to the `tasks` module: templates, tasks and their
-- revisions, assignments (one per addressee), reports with their versions and
-- review decisions, and the operation log. Account and community ids are
-- opaque text (no cross-module foreign keys); in-module foreign keys are
-- RESTRICT. Purely additive: no existing table is touched.

CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"kind" text NOT NULL,
	"buttons" jsonb NOT NULL,
	"report_required" boolean NOT NULL,
	"approval_mode" text NOT NULL,
	"audiences" jsonb NOT NULL,
	"community_id" text,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"archived_at" timestamp with time zone,
	"template_id" text,
	"republished_from" text,
	"client_request_id" text,
	CONSTRAINT "tasks_status_valid" CHECK ("tasks"."status" in ('OPEN', 'CANCELLED')),
	CONSTRAINT "tasks_kind_valid" CHECK ("tasks"."kind" in ('GENERAL', 'ATTENDANCE', 'TEACHING')),
	CONSTRAINT "tasks_mode_valid" CHECK ("tasks"."approval_mode" in ('AUTO', 'MANUAL')),
	CONSTRAINT "tasks_revision_positive" CHECK ("tasks"."revision" >= 1),
	CONSTRAINT "tasks_title_length" CHECK (char_length("tasks"."title") between 1 and 200),
	CONSTRAINT "tasks_audiences_array" CHECK (jsonb_typeof("tasks"."audiences") = 'array'),
	CONSTRAINT "tasks_buttons_array" CHECK (jsonb_typeof("tasks"."buttons") = 'array'),
	CONSTRAINT "tasks_cancelled_consistent" CHECK (("tasks"."status" = 'CANCELLED') = ("tasks"."cancelled_at" is not null and "tasks"."cancelled_by" is not null)
          and ("tasks"."status" <> 'CANCELLED' or "tasks"."archived_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "tasks_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"audience" text NOT NULL,
	"status" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_revision" integer,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"reassigned_to" text,
	"reassigned_at" timestamp with time zone,
	"reassigned_by" text,
	"replaces" text,
	CONSTRAINT "tasks_assignments_status_valid" CHECK ("tasks_assignments"."status" in ('PENDING', 'ACKNOWLEDGED', 'COMPLETED', 'REASSIGNED')),
	CONSTRAINT "tasks_assignments_audience_valid" CHECK ("tasks_assignments"."audience" in ('TEACHERS', 'SUPERVISORS', 'ADMINISTRATION')),
	CONSTRAINT "tasks_assignments_completed_consistent" CHECK (("tasks_assignments"."status" = 'COMPLETED') = ("tasks_assignments"."completed_at" is not null) or "tasks_assignments"."status" = 'REASSIGNED'),
	CONSTRAINT "tasks_assignments_reassigned_consistent" CHECK (("tasks_assignments"."status" = 'REASSIGNED') = ("tasks_assignments"."reassigned_to" is not null and "tasks_assignments"."reassigned_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "tasks_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" text,
	"assignment_id" text,
	"report_id" text,
	"detail" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tasks_events_action_shape" CHECK ("tasks_events"."action" ~ '^[A-Z][A-Z_]{0,63}$'),
	CONSTRAINT "tasks_events_detail_object" CHECK (jsonb_typeof("tasks_events"."detail") = 'object')
);
--> statement-breakpoint
CREATE TABLE "tasks_report_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"version" integer NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"reviewer_id" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tasks_report_reviews_decision_valid" CHECK ("tasks_report_reviews"."decision" in ('APPROVED', 'CHANGES_REQUESTED'))
);
--> statement-breakpoint
CREATE TABLE "tasks_report_versions" (
	"report_id" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"edited_by" text NOT NULL,
	"edited_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tasks_report_versions_report_id_version_pk" PRIMARY KEY("report_id","version"),
	CONSTRAINT "tasks_report_versions_body_length" CHECK (char_length("tasks_report_versions"."body") between 1 and 20000)
);
--> statement-breakpoint
CREATE TABLE "tasks_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"author_id" text NOT NULL,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	CONSTRAINT "tasks_reports_status_valid" CHECK ("tasks_reports"."status" in ('PENDING_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'DELETED')),
	CONSTRAINT "tasks_reports_category_valid" CHECK ("tasks_reports"."category" in ('TASK_COMPLETION', 'ATTENDANCE', 'TEACHERS')),
	CONSTRAINT "tasks_reports_version_positive" CHECK ("tasks_reports"."version" >= 1),
	CONSTRAINT "tasks_reports_approved_consistent" CHECK (("tasks_reports"."status" = 'APPROVED') = ("tasks_reports"."approved_at" is not null)),
	CONSTRAINT "tasks_reports_deleted_consistent" CHECK (("tasks_reports"."status" = 'DELETED') = ("tasks_reports"."deleted_at" is not null and "tasks_reports"."deleted_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "tasks_revisions" (
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"kind" text NOT NULL,
	"buttons" jsonb NOT NULL,
	"report_required" boolean NOT NULL,
	"approval_mode" text NOT NULL,
	"edited_by" text NOT NULL,
	"edited_at" timestamp with time zone NOT NULL,
	"require_reacknowledge" boolean NOT NULL,
	CONSTRAINT "tasks_revisions_task_id_revision_pk" PRIMARY KEY("task_id","revision")
);
--> statement-breakpoint
CREATE TABLE "tasks_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"kind" text NOT NULL,
	"buttons" jsonb NOT NULL,
	"report_required" boolean NOT NULL,
	"approval_mode" text NOT NULL,
	"audiences" jsonb NOT NULL,
	"community_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tasks_templates_kind_valid" CHECK ("tasks_templates"."kind" in ('GENERAL', 'ATTENDANCE', 'TEACHING')),
	CONSTRAINT "tasks_templates_mode_valid" CHECK ("tasks_templates"."approval_mode" in ('AUTO', 'MANUAL'))
);
--> statement-breakpoint
ALTER TABLE "tasks_assignments" ADD CONSTRAINT "tasks_assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_events" ADD CONSTRAINT "tasks_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_report_reviews" ADD CONSTRAINT "tasks_report_reviews_report_id_tasks_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."tasks_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_report_versions" ADD CONSTRAINT "tasks_report_versions_report_id_tasks_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."tasks_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_reports" ADD CONSTRAINT "tasks_reports_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_reports" ADD CONSTRAINT "tasks_reports_assignment_id_tasks_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."tasks_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks_revisions" ADD CONSTRAINT "tasks_revisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_newest" ON "tasks" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_by_community" ON "tasks" USING btree ("community_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_client_request_unique" ON "tasks" USING btree ("created_by","client_request_id") WHERE "tasks"."client_request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_assignments_one_open_per_person" ON "tasks_assignments" USING btree ("task_id","recipient_id") WHERE "tasks_assignments"."status" <> 'REASSIGNED';--> statement-breakpoint
CREATE INDEX "tasks_assignments_by_task" ON "tasks_assignments" USING btree ("task_id","created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_assignments_by_recipient" ON "tasks_assignments" USING btree ("recipient_id","created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_events_by_task" ON "tasks_events" USING btree ("task_id","sequence");--> statement-breakpoint
CREATE INDEX "tasks_report_reviews_by_report" ON "tasks_report_reviews" USING btree ("report_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_reports_one_per_assignment" ON "tasks_reports" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "tasks_reports_recent" ON "tasks_reports" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "tasks_reports_by_task" ON "tasks_reports" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_templates_newest" ON "tasks_templates" USING btree ("created_at","id");