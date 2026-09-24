import { communityChatStoreContract } from '../../../../test/support/community-chat-contract-suite';
import { InMemoryMessagingStore } from './in-memory-messaging-store';

// Mock mode keeps every guarantee the Postgres adapters give; the Postgres
// suite runs the same contract over Drizzle.
communityChatStoreContract('in memory', () => {
  const store = new InMemoryMessagingStore();
  return { repository: store, readModel: store };
});
