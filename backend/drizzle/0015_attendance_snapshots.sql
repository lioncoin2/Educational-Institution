CREATE TABLE "attendance_snapshot_entries" (
	"snapshot_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection" text NOT NULL,
	CONSTRAINT "attendance_snapshot_entries_snapshot_id_user_id_pk" PRIMARY KEY("snapshot_id","user_id"),
	CONSTRAINT "attendance_snapshot_entries_connection_valid" CHECK ("attendance_snapshot_entries"."connection" in ('CONNECTED', 'CONNECTING'))
);
--> statement-breakpoint
CREATE TABLE "attendance_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"community_id" text NOT NULL,
	"live_session_id" text NOT NULL,
	"host_user_id" text NOT NULL,
	"recorded_by" text NOT NULL,
	"client_request_id" text NOT NULL,
	"observation_rule" text NOT NULL,
	"observation_started_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"connected_count" integer NOT NULL,
	"connecting_count" integer NOT NULL,
	CONSTRAINT "attendance_snapshots_idempotency_unique" UNIQUE("live_session_id","recorded_by","client_request_id"),
	CONSTRAINT "attendance_snapshots_client_request_id_shape" CHECK ("attendance_snapshots"."client_request_id" ~ '^[A-Za-z0-9_-]{8,64}$'),
	CONSTRAINT "attendance_snapshots_observation_rule_valid" CHECK ("attendance_snapshots"."observation_rule" in ('provider_registry_v1')),
	CONSTRAINT "attendance_snapshots_counts_non_negative" CHECK ("attendance_snapshots"."connected_count" >= 0 and "attendance_snapshots"."connecting_count" >= 0),
	CONSTRAINT "attendance_snapshots_time_order" CHECK ("attendance_snapshots"."observed_at" >= "attendance_snapshots"."observation_started_at" and "attendance_snapshots"."recorded_at" >= "attendance_snapshots"."observed_at")
);
--> statement-breakpoint
ALTER TABLE "attendance_snapshot_entries" ADD CONSTRAINT "attendance_snapshot_entries_snapshot_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."attendance_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_snapshots_community_idx" ON "attendance_snapshots" USING btree ("community_id","observed_at","id");--> statement-breakpoint
CREATE INDEX "attendance_snapshots_session_idx" ON "attendance_snapshots" USING btree ("live_session_id","observed_at","id");