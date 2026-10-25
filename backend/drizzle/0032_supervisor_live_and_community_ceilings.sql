-- Owner policy revision 2026-10-25 (ADR 0044, decisions A and B): supervisors
-- may start broadcasts and add members — in the communities they are
-- permitted to act in, never by their role alone.
--
-- Data only, and only CEILINGS: these three identity permissions make a
-- SUPERVISOR eligible to own a community or to be granted a community
-- capability there (community.live.start, community.members.invite, …), as a
-- TEACHER already is. They grant nothing in any community by themselves —
-- every act still needs the community-level basis (owner standing or an
-- ACTIVE grant), and oversight still never adds members or acts in live
-- sessions (Q43). live.speak is the host's own publish ceiling: whoever starts
-- a session becomes its host and speaks by right (Q54).
--
-- Seed values are GENERATED from the TypeScript constants, not transcribed,
-- and test/integration verifies the database and the constants agree.

INSERT INTO "role_permissions" ("role_code", "permission_code") VALUES
  ('SUPERVISOR', 'live.speak'),
  ('SUPERVISOR', 'live.moderate'),
  ('SUPERVISOR', 'communities.moderate');
