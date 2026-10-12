-- Least-privilege people directory (Sprint 24, approved Design X).
--
-- The institution-wide people directory (`GET /people`, gated on `people.read`)
-- is a membership-management surface for owner/admin only. Supervisors and
-- teachers previously held `people.read` and so could search the whole
-- institution's accounts; the owner ruled that neither should retain a global
-- directory merely because they hold that permission (open-questions.md Q31/Q50,
-- the people-lookup policy). Community member discovery moves to a
-- community-scoped candidate search gated per community on
-- `community.members.invite`, so a teacher who owns or is delegated invitation
-- authority in a community can still find candidates there — without a global
-- directory. Owner/admin keep `people.read` (they hold every permission they
-- grant). Students and parents gain nothing. No capability is otherwise changed.
--
-- Data-only and forward-only: it removes two role→permission grants and makes no
-- schema change. The `people.read` permission row itself is kept (owner/admin
-- still hold it). The DELETE is naturally idempotent. Seed values mirror the
-- TypeScript constants (src/modules/identity/domain/provisional-policy.ts), and
-- test/integration/identity-persistence verifies the database and the constants
-- agree.

DELETE FROM "role_permissions"
 WHERE "permission_code" = 'people.read'
   AND "role_code" IN ('SUPERVISOR', 'TEACHER');
