/**
 * Messaging's public surface: its vocabulary, the events it publishes, the
 * recipients query delivery modules use, and the search extension point.
 * Everything else — conversations, membership, messages, read state — is
 * owned here and reachable only through messaging's own use cases.
 */
export * from './events';
export * from './message-recipients';
export * from './message-search';
export * from './vocabulary';
