-- Identity & Access V1, step 2 of 3: data.
--
-- Runs between an additive migration (0001: new tables) and a subtractive one
-- (0003: drop users.email, tighten constraints), so existing rows are carried
-- across rather than lost.
--
-- Seed values are GENERATED from the TypeScript constants, not transcribed, and
-- test/integration verifies the database and the constants agree.

-- Roles active in this milestone.
INSERT INTO "roles" ("code", "description") VALUES
  ('OWNER', 'The institution owner.'),
  ('ADMIN', 'Operational administrator.'),
  ('SUPERVISOR', 'Oversees teachers and halaqat.'),
  ('TEACHER', 'Teaches halaqat and hosts live sessions.'),
  ('ASSISTANT_TEACHER', 'Assists a teacher.'),
  ('STUDENT', 'A learner.');
--> statement-breakpoint
-- The permission catalogue (src/modules/identity/contracts/permissions.ts).
INSERT INTO "permissions" ("code", "description") VALUES
  ('users.read', 'View accounts, their status and roles.'),
  ('users.manage', 'Create accounts, change their status, reset their passwords.'),
  ('roles.assign', 'Grant and remove roles on accounts.'),
  ('sessions.manage', 'End other accounts'' sessions.'),
  ('audit.read', 'Read the audit log.'),
  ('settings.manage', 'Change system-wide settings.'),
  ('people.read', 'View person records.'),
  ('people.manage', 'Create and change person records.'),
  ('academic.read', 'View programs, levels and halaqat.'),
  ('academic.manage', 'Create and change programs, levels and halaqat.'),
  ('attendance.read', 'View attendance.'),
  ('attendance.manage', 'Record and amend attendance.'),
  ('assignments.read', 'View assignments.'),
  ('assignments.submit', 'Submit work for an assignment.'),
  ('assignments.manage', 'Create, change and grade assignments.'),
  ('messaging.read', 'Read conversations one takes part in.'),
  ('messaging.send', 'Send messages.'),
  ('messaging.manage', 'Moderate conversations, including others''.'),
  ('live.join', 'Join live sessions as a listener.'),
  ('live.raise_hand', 'Ask to speak in a live session.'),
  ('live.speak', 'Speak in live sessions one hosts.'),
  ('live.moderate', 'Grant, revoke and mute speakers in live sessions one hosts.'),
  ('files.read', 'Download files one may see.'),
  ('files.upload', 'Upload files.'),
  ('reports.read', 'View reports.');
--> statement-breakpoint
-- PROVISIONAL role -> permission matrix (src/modules/identity/domain/provisional-policy.ts).
-- NOT confirmed by the institution: open-questions.md Q1. A test fails if this
-- and the constant disagree.
INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('OWNER', 'users.read'),
  ('OWNER', 'users.manage'),
  ('OWNER', 'roles.assign'),
  ('OWNER', 'sessions.manage'),
  ('OWNER', 'audit.read'),
  ('OWNER', 'settings.manage'),
  ('OWNER', 'people.read'),
  ('OWNER', 'people.manage'),
  ('OWNER', 'academic.read'),
  ('OWNER', 'academic.manage'),
  ('OWNER', 'attendance.read'),
  ('OWNER', 'attendance.manage'),
  ('OWNER', 'assignments.read'),
  ('OWNER', 'assignments.submit'),
  ('OWNER', 'assignments.manage'),
  ('OWNER', 'messaging.read'),
  ('OWNER', 'messaging.send'),
  ('OWNER', 'messaging.manage'),
  ('OWNER', 'live.join'),
  ('OWNER', 'live.raise_hand'),
  ('OWNER', 'live.speak'),
  ('OWNER', 'live.moderate'),
  ('OWNER', 'files.read'),
  ('OWNER', 'files.upload'),
  ('OWNER', 'reports.read'),
  ('ADMIN', 'users.read'),
  ('ADMIN', 'users.manage'),
  ('ADMIN', 'roles.assign'),
  ('ADMIN', 'sessions.manage'),
  ('ADMIN', 'audit.read'),
  ('ADMIN', 'people.read'),
  ('ADMIN', 'people.manage'),
  ('ADMIN', 'academic.read'),
  ('ADMIN', 'academic.manage'),
  ('ADMIN', 'attendance.read'),
  ('ADMIN', 'attendance.manage'),
  ('ADMIN', 'assignments.read'),
  ('ADMIN', 'assignments.submit'),
  ('ADMIN', 'assignments.manage'),
  ('ADMIN', 'messaging.read'),
  ('ADMIN', 'messaging.send'),
  ('ADMIN', 'live.join'),
  ('ADMIN', 'live.raise_hand'),
  ('ADMIN', 'live.speak'),
  ('ADMIN', 'live.moderate'),
  ('ADMIN', 'files.read'),
  ('ADMIN', 'files.upload'),
  ('ADMIN', 'reports.read'),
  ('SUPERVISOR', 'users.read'),
  ('SUPERVISOR', 'people.read'),
  ('SUPERVISOR', 'academic.read'),
  ('SUPERVISOR', 'attendance.read'),
  ('SUPERVISOR', 'assignments.read'),
  ('SUPERVISOR', 'reports.read'),
  ('SUPERVISOR', 'messaging.read'),
  ('SUPERVISOR', 'messaging.send'),
  ('SUPERVISOR', 'live.join'),
  ('SUPERVISOR', 'files.read'),
  ('TEACHER', 'people.read'),
  ('TEACHER', 'academic.read'),
  ('TEACHER', 'attendance.read'),
  ('TEACHER', 'attendance.manage'),
  ('TEACHER', 'assignments.read'),
  ('TEACHER', 'assignments.manage'),
  ('TEACHER', 'messaging.read'),
  ('TEACHER', 'messaging.send'),
  ('TEACHER', 'live.join'),
  ('TEACHER', 'live.speak'),
  ('TEACHER', 'live.moderate'),
  ('TEACHER', 'files.read'),
  ('TEACHER', 'files.upload'),
  ('ASSISTANT_TEACHER', 'academic.read'),
  ('ASSISTANT_TEACHER', 'attendance.read'),
  ('ASSISTANT_TEACHER', 'assignments.read'),
  ('ASSISTANT_TEACHER', 'messaging.read'),
  ('ASSISTANT_TEACHER', 'messaging.send'),
  ('ASSISTANT_TEACHER', 'live.join'),
  ('ASSISTANT_TEACHER', 'files.read'),
  ('STUDENT', 'academic.read'),
  ('STUDENT', 'assignments.read'),
  ('STUDENT', 'assignments.submit'),
  ('STUDENT', 'messaging.read'),
  ('STUDENT', 'messaging.send'),
  ('STUDENT', 'live.join'),
  ('STUDENT', 'live.raise_hand'),
  ('STUDENT', 'files.read'),
  ('STUDENT', 'files.upload');
--> statement-breakpoint
-- Login identifiers move out of `users` so email is one identifier kind among
-- several. Emails were already stored normalized by the previous repository.
INSERT INTO "user_identifiers" ("user_id", "kind", "value", "created_at")
SELECT "id", 'email', "email", "created_at" FROM "users";
--> statement-breakpoint
-- No password change was ever recorded before this column existed; the row's
-- last update is the closest honest upper bound.
UPDATE "users" SET "password_changed_at" = "updated_at";
