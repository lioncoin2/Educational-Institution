-- Student-to-student direct messaging (GROUP A, Q6), owner ruling 2026-10-11.
--
-- One permission split out of "messaging.start_direct": starting a direct
-- conversation with a PEER. Who may initiate contact with whom is a
-- safeguarding decision (open-questions.md Q6); the owner answered only "may
-- students message each other?" (yes), leaving "may a student DM a teacher?"
-- open. A broad `messaging.start_direct` would resolve that open question by a
-- side effect (a student could then address any staff account), so students
-- get this narrower permission instead: it reaches only another holder of it
-- who is not a broad starter, i.e. another student.
--
-- Seed values are GENERATED from the TypeScript constants, not transcribed,
-- and test/integration verifies the database and the constants agree.

INSERT INTO "permissions" ("code", "description") VALUES
  ('messaging.start_direct_peer', 'Start a direct conversation with a peer (student-to-student).');
--> statement-breakpoint
-- PROVISIONAL grants (src/modules/identity/domain/provisional-policy.ts), not
-- confirmed by the institution: open-questions.md Q1 and Q6. OWNER and ADMIN
-- hold it because they hold everything the roles they onboard hold (the
-- no-escalation rule, authorization.md §4); STUDENT holds it by the owner's
-- GROUP A ruling. A test fails if the table and the constant disagree.
INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('OWNER', 'messaging.start_direct_peer'),
  ('ADMIN', 'messaging.start_direct_peer'),
  ('STUDENT', 'messaging.start_direct_peer');
