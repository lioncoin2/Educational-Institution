CREATE TABLE "live_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"position" bigserial NOT NULL,
	"sender_id" text NOT NULL,
	"client_message_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "live_chat_messages_body_length" CHECK (char_length("live_chat_messages"."body") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "live_sessions" ADD COLUMN "chat_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD COLUMN "chat_lock_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "live_chat_messages" ADD CONSTRAINT "live_chat_messages_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_chat_messages_one_per_client_key" ON "live_chat_messages" USING btree ("session_id","sender_id","client_message_id");--> statement-breakpoint
CREATE INDEX "live_chat_messages_session_page_idx" ON "live_chat_messages" USING btree ("session_id","position");--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_chat_lock_version_nonnegative" CHECK ("live_sessions"."chat_lock_version" >= 0);