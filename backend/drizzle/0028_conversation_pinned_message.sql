ALTER TABLE "conversations" ADD COLUMN "pinned_message_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "pinned_by" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_pinned_message_id_messages_id_fk" FOREIGN KEY ("pinned_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_pin_consistent" CHECK (("conversations"."pinned_message_id" is null) = ("conversations"."pinned_at" is null) and ("conversations"."pinned_message_id" is null) = ("conversations"."pinned_by" is null));