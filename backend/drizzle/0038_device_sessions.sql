ALTER TABLE "notification_devices" ADD COLUMN "session_id" text;--> statement-breakpoint
CREATE INDEX "notification_devices_session_idx" ON "notification_devices" USING btree ("session_id");