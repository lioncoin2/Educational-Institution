-- Communities, step 1 of 2: identity data (docs/architecture/communities.md §6.2).
--
-- Four ceilings. None is sufficient alone: which communities a person may act
-- in, and how, is decided by Communities' own records — membership, ownership
-- and oversight — never by holding one of these.
--
-- Seed values are GENERATED from the TypeScript constants, not transcribed,
-- and test/integration verifies the database and the constants agree.

INSERT INTO "permissions" ("code", "description") VALUES
  ('communities.read', 'May take part in the communities one belongs to, and become a member of one.'),
  ('communities.create', 'May create a community; the creator becomes its owner.'),
  ('communities.moderate', 'May own a community or hold a delegated capability in one; grants nothing by itself.'),
  ('communities.manage', 'Institutional oversight of communities one does not belong to; never adds members.');
--> statement-breakpoint
-- PROVISIONAL grants (src/modules/identity/domain/provisional-policy.ts), not
-- confirmed by the institution: open-questions.md Q41 (who takes part and who
-- creates), Q43 (oversight) and Q44 (who may own or hold a capability). OWNER
-- and ADMIN hold all four because they hold everything the roles they onboard
-- hold (the no-escalation rule, authorization.md §4). A test fails if the
-- table and the constant disagree.
INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('OWNER', 'communities.read'),
  ('OWNER', 'communities.create'),
  ('OWNER', 'communities.moderate'),
  ('OWNER', 'communities.manage'),
  ('ADMIN', 'communities.read'),
  ('ADMIN', 'communities.create'),
  ('ADMIN', 'communities.moderate'),
  ('ADMIN', 'communities.manage'),
  ('SUPERVISOR', 'communities.read'),
  ('TEACHER', 'communities.read'),
  ('TEACHER', 'communities.moderate'),
  ('ASSISTANT_TEACHER', 'communities.read'),
  ('STUDENT', 'communities.read');
