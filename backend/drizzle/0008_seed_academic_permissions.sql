-- Academic Core V1, step 2 of 2: data.
--
-- Two permissions that grant nothing by themselves: they say which accounts
-- may be ASSIGNED to teach a halaqa (academic.teach) or ENROLLED in one
-- (academic.study), so academic never has to branch on a role name. What a
-- teacher may see comes from their assignment to a halaqa, not from these.
--
-- Seed values are GENERATED from the TypeScript constants, not transcribed,
-- and test/integration verifies the database and the constants agree.

INSERT INTO "permissions" ("code", "description") VALUES
  ('academic.teach', 'May be assigned to teach halaqat; the assignment is what grants access to a halaqa.'),
  ('academic.study', 'May be enrolled in halaqat as a learner.');
--> statement-breakpoint
-- PROVISIONAL grants (src/modules/identity/domain/provisional-policy.ts), not
-- confirmed by the institution: open-questions.md Q1, Q30 and Q31. OWNER and
-- ADMIN hold both because they hold everything the roles they onboard hold
-- (the no-escalation rule, authorization.md §4). A test fails if the table
-- and the constant disagree.
INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('OWNER', 'academic.teach'),
  ('OWNER', 'academic.study'),
  ('ADMIN', 'academic.teach'),
  ('ADMIN', 'academic.study'),
  ('TEACHER', 'academic.teach'),
  ('ASSISTANT_TEACHER', 'academic.teach'),
  ('STUDENT', 'academic.study');
