import type { Id } from '../../../shared/identifier';

/** Identifier types, on their own so every domain file can name them without importing another. */
export type ConversationId = Id<'Conversation'>;
export type MessageId = Id<'Message'>;
