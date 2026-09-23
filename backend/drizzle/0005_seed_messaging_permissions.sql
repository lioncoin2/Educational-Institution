-- Messaging V1, step 2 of 2: data.
--
-- Three permissions split out of "messaging.send": starting a direct
-- conversation, creating a group, creating a channel. Who may initiate
-- contact is a safeguarding decision (open-questions.md Q6), so it is
-- granted separately from taking part.
--
-- Seed values are GENERATED from the TypeScript constants, not transcribed,
-- and test/integration verifies the database and the constants agree.

INSERT INTO "permissions" ("code", "description") VALUES
  ('messaging.start_direct', 'Start a direct conversation with another account.'),
  ('messaging.create_group', 'Create group conversations and manage their members.'),
  ('messaging.create_channel', 'Create broadcast channels and manage their members.');
--> statement-breakpoint
-- PROVISIONAL grants (src/modules/identity/domain/provisional-policy.ts), not
-- confirmed by the institution: open-questions.md Q1 and Q6. A test fails if
-- the table and the constant disagree.
INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('OWNER', 'messaging.start_direct'),
  ('OWNER', 'messaging.create_group'),
  ('OWNER', 'messaging.create_channel'),
  ('ADMIN', 'messaging.start_direct'),
  ('ADMIN', 'messaging.create_group'),
  ('ADMIN', 'messaging.create_channel'),
  ('SUPERVISOR', 'messaging.start_direct'),
  ('SUPERVISOR', 'messaging.create_group'),
  ('TEACHER', 'messaging.start_direct'),
  ('TEACHER', 'messaging.create_group');
