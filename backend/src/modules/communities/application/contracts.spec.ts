import { communityContractSuite } from '../../../../test/support/communities-contract-suite';
import { communitiesHarness } from '../../../../test/support/communities-harness';

/**
 * COMMUNITY_MEMBERSHIP and COMMUNITY_DIRECTORY over the in-memory store. The
 * Postgres suite runs the same cases against the database adapter.
 */
describe('Communities contracts — in memory', () => {
  communityContractSuite(async () => communitiesHarness());
});
