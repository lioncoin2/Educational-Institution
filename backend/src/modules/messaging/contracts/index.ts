/**
 * Messaging's public surface: its vocabulary, the events it publishes, what
 * a member sees of a message, the recipients and delivery queries delivery
 * modules use, and the search extension point. Everything else —
 * conversations, membership, messages, read state — is owned here and
 * reachable only through messaging's own use cases.
 */
export * from './events';
export * from './message-delivery';
export * from './message-recipients';
export * from './message-view';
export * from './message-search';
export * from './vocabulary';
