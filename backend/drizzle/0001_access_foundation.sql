CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"previous_refresh_token_hash" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"device_platform" text DEFAULT 'unknown' NOT NULL,
	"device_label" text,
	"app_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "auth_sessions_platform_valid" CHECK ("auth_sessions"."device_platform" in ('ios', 'android', 'web', 'unknown')),
	CONSTRAINT "auth_sessions_revocation_consistent" CHECK (("auth_sessions"."revoked_at" is null) = ("auth_sessions"."revoked_reason" is null)),
	CONSTRAINT "auth_sessions_reason_valid" CHECK ("auth_sessions"."revoked_reason" is null or "auth_sessions"."revoked_reason" in ('logout', 'revoked_by_user', 'revoked_by_admin', 'refresh_token_reuse', 'password_changed', 'password_reset', 'account_suspended', 'account_disabled', 'account_inactive')),
	CONSTRAINT "auth_sessions_expiry_after_creation" CHECK ("auth_sessions"."expires_at" > "auth_sessions"."created_at"),
	CONSTRAINT "auth_sessions_generation_nonnegative" CHECK ("auth_sessions"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "permissions_code_shape" CHECK ("permissions"."code" ~ '^[a-z]+[.][a-z_]+$')
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_code" text NOT NULL,
	"permission_code" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_code_permission_code_pk" PRIMARY KEY("role_code","permission_code")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_shape" CHECK ("roles"."code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "user_identifiers" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identifiers_kind_value_pk" PRIMARY KEY("kind","value"),
	CONSTRAINT "user_identifiers_kind_valid" CHECK ("user_identifiers"."kind" in ('email')),
	CONSTRAINT "user_identifiers_value_present" CHECK (length("user_identifiers"."value") > 0)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_code_roles_code_fk" FOREIGN KEY ("role_code") REFERENCES "public"."roles"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identifiers" ADD CONSTRAINT "user_identifiers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_sessions_user_live_idx" ON "auth_sessions" USING btree ("user_id") WHERE "auth_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "user_identifiers_user_id_idx" ON "user_identifiers" USING btree ("user_id");