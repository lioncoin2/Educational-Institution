CREATE TABLE "conversation_mutes" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"muted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_mutes_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id"),
	CONSTRAINT "conversation_mutes_conversation_id_length" CHECK (char_length("conversation_mutes"."conversation_id") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "institution_notification_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"quiet_hours_enabled" boolean NOT NULL,
	"quiet_hours_start" text NOT NULL,
	"quiet_hours_end" text NOT NULL,
	"timezone" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "institution_notification_settings_singleton" CHECK ("institution_notification_settings"."id" = 'institution'),
	CONSTRAINT "institution_notification_settings_window_shape" CHECK ("institution_notification_settings"."quiet_hours_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "institution_notification_settings"."quiet_hours_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "institution_notification_settings_window_nonempty" CHECK ("institution_notification_settings"."quiet_hours_start" <> "institution_notification_settings"."quiet_hours_end"),
	CONSTRAINT "institution_notification_settings_timezone_length" CHECK (char_length("institution_notification_settings"."timezone") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "user_notification_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"timezone" text,
	"quiet_hours_mode" text NOT NULL,
	"quiet_hours_start" text,
	"quiet_hours_end" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_notification_settings_mode_valid" CHECK ("user_notification_settings"."quiet_hours_mode" in ('INHERIT', 'DISABLED', 'CUSTOM')),
	CONSTRAINT "user_notification_settings_timezone_length" CHECK ("user_notification_settings"."timezone" is null or char_length("user_notification_settings"."timezone") between 1 and 64),
	CONSTRAINT "user_notification_settings_custom_window" CHECK (("user_notification_settings"."quiet_hours_mode" = 'CUSTOM' and "user_notification_settings"."quiet_hours_start" is not null and "user_notification_settings"."quiet_hours_end" is not null and "user_notification_settings"."quiet_hours_start" <> "user_notification_settings"."quiet_hours_end") or ("user_notification_settings"."quiet_hours_mode" <> 'CUSTOM' and "user_notification_settings"."quiet_hours_start" is null and "user_notification_settings"."quiet_hours_end" is null)),
	CONSTRAINT "user_notification_settings_window_shape" CHECK (("user_notification_settings"."quiet_hours_start" is null or "user_notification_settings"."quiet_hours_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') and ("user_notification_settings"."quiet_hours_end" is null or "user_notification_settings"."quiet_hours_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
);
--> statement-breakpoint
CREATE INDEX "conversation_mutes_user_idx" ON "conversation_mutes" USING btree ("user_id","muted_at");