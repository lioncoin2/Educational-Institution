-- Operations scheduling (ADR 0042), step 2 of 2: data.
--
-- Seeds the `operations.schedule_manage` capability — create, reschedule and
-- cancel individual dated lessons — and its PROVISIONAL OWNER/ADMIN grants.
-- The owner named it `operations.schedule.manage`; the stored code uses a
-- single dot (`schedule_manage`) because the `permissions_code_shape` CHECK
-- (migration 0001, immutable) allows one `namespace.action` dot. The meaning
-- is unchanged.
--
-- Seed values are GENERATED from the TypeScript constants (permissions.ts +
-- provisional-policy.ts), not transcribed, and test/integration/
-- identity-persistence verifies the database and the constants agree.

INSERT INTO "permissions" ("code", "description") VALUES
	('operations.schedule_manage', 'May schedule individual dated lessons: create, reschedule and cancel them.');
--> statement-breakpoint
-- PROVISIONAL grants: OWNER holds every permission; ADMIN holds every
-- permission except settings.manage and messaging.manage, so both hold
-- scheduling. No other role is granted it.
INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
	('OWNER', 'operations.schedule_manage'),
	('ADMIN', 'operations.schedule_manage');
