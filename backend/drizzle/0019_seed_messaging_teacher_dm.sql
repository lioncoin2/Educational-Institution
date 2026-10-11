-- Student-to-teacher direct messaging (GROUP A, Q6), owner ruling 2026-10-11.
--
-- A second permission split out of "messaging.start_direct": starting a direct
-- conversation with an eligible TEACHER. The owner decided a student may
-- initiate a direct conversation with any eligible teacher in the (single)
-- institution — but NOT with an administrator or a parent. A broad
-- `messaging.start_direct` would reach any account, so students get this
-- narrower permission instead: the use case pairs it with an eligibility check
-- that the counterpart holds `academic.teach` (the catalogue's "is a teacher's
-- account" marker) and is NOT an administrator (holds no `users.manage`), so a
-- student reaches teachers and assistant teachers, never the owner or an admin.
--
-- Seed values are GENERATED from the TypeScript constants, not transcribed,
-- and test/integration verifies the database and the constants agree.

INSERT INTO "permissions" ("code", "description") VALUES
  ('messaging.start_direct_teacher', 'Start a direct conversation with an eligible teacher (student-to-teacher).');
--> statement-breakpoint
-- PROVISIONAL grants (src/modules/identity/domain/provisional-policy.ts), not
-- confirmed by the institution: open-questions.md Q1 and Q6. OWNER and ADMIN
-- hold it because they hold everything the roles they onboard hold (the
-- no-escalation rule, authorization.md §4); STUDENT holds it by the owner's
-- GROUP A ruling. A test fails if the table and the constant disagree.
INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('OWNER', 'messaging.start_direct_teacher'),
  ('ADMIN', 'messaging.start_direct_teacher'),
  ('STUDENT', 'messaging.start_direct_teacher');
