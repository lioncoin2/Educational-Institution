-- Daily tasks & reports engine (ADR 0052), step 2 of 2: data.
--
-- Seeds the three task capabilities and their PROVISIONAL grants. Seed values
-- are GENERATED from the TypeScript constants (permissions.ts +
-- provisional-policy.ts), and test/integration/identity-persistence verifies
-- the database and the constants agree.

INSERT INTO "permissions" ("code", "description") VALUES
	('tasks.manage', 'May publish daily tasks to the staff audiences, follow, edit, cancel, reopen, reassign and remind them, and read, edit, delete and review every report.'),
	('tasks.template', 'May save tasks as templates and re-publish past tasks as new ones.'),
	('tasks.respond', 'May receive daily tasks addressed to their audience: acknowledge, complete and report on them.');
--> statement-breakpoint
-- PROVISIONAL grants: OWNER holds every permission; ADMIN every permission
-- except settings.manage, messaging.manage and tasks.template (templates and
-- re-publishing are the owner's, roadmap §10); the addressable staff roles
-- respond.
INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
	('OWNER', 'tasks.manage'),
	('OWNER', 'tasks.template'),
	('OWNER', 'tasks.respond'),
	('ADMIN', 'tasks.manage'),
	('ADMIN', 'tasks.respond'),
	('SUPERVISOR', 'tasks.respond'),
	('TEACHER', 'tasks.respond'),
	('ASSISTANT_TEACHER', 'tasks.respond');
