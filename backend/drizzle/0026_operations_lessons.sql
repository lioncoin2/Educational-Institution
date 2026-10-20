CREATE TABLE "operations_lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"halaqa_id" text NOT NULL,
	"title" text,
	"local_date" text NOT NULL,
	"local_time" text NOT NULL,
	"timezone" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"client_request_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	CONSTRAINT "operations_lessons_status_valid" CHECK ("operations_lessons"."status" in ('SCHEDULED', 'CANCELLED')),
	CONSTRAINT "operations_lessons_local_date_shape" CHECK ("operations_lessons"."local_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "operations_lessons_local_time_shape" CHECK ("operations_lessons"."local_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "operations_lessons_cancelled_consistent" CHECK (("operations_lessons"."status" = 'CANCELLED') = ("operations_lessons"."cancelled_at" is not null and "operations_lessons"."cancelled_by" is not null)),
	CONSTRAINT "operations_lessons_updated_after_created" CHECK ("operations_lessons"."updated_at" >= "operations_lessons"."created_at")
);
--> statement-breakpoint
CREATE INDEX "operations_lessons_by_schedule" ON "operations_lessons" USING btree ("scheduled_at","id");--> statement-breakpoint
CREATE INDEX "operations_lessons_by_halaqa_schedule" ON "operations_lessons" USING btree ("halaqa_id","scheduled_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "operations_lessons_client_request_unique" ON "operations_lessons" USING btree ("created_by","client_request_id") WHERE "operations_lessons"."client_request_id" is not null;