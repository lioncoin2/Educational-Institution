import type { ConversationType, MessageType, ParticipantRole } from '../contracts/vocabulary';

/**
 * A message and its files, as a member sees them, are part of messaging's
 * public contract — the realtime module delivers exactly these — so they are
 * defined in `contracts/` and re-exported here for the application's use.
 */
import type { AttachmentView, MessageView, PersonView } from '../contracts/message-view';

export type { AttachmentView, MessageView, PersonView };

export interface MessagePreview {
  readonly sequence: number;
  readonly senderId: string;
  readonly senderName: string | null;
  readonly type: MessageType;
  /** The start of the text or caption; null for media without one and for deleted messages. */
  readonly text: string | null;
  readonly deleted: boolean;
  readonly createdAt: Date;
}

export interface ConversationView {
  readonly id: string;
  readonly type: ConversationType;
  /** Group/channel: its title. Direct: the other person's name. */
  readonly title: string | null;
  readonly counterpartUserId: string | null;
  readonly memberCount: number;
  readonly myRole: ParticipantRole;
  readonly canPost: boolean;
  readonly canManageMembers: boolean;
  readonly lastSequence: number;
  readonly lastReadSequence: number;
  /** Capped: from UNREAD_COUNT_CAP on, show "99+". */
  readonly unreadCount: number;
  readonly lastMessage: MessagePreview | null;
  readonly createdAt: Date;
  /** When anything last happened — the list's order. */
  readonly activityAt: Date;
}

export interface MessagePage {
  /** Ascending by sequence. */
  readonly items: readonly MessageView[];
  /** Pass the first item's sequence as `before` for more. */
  readonly hasOlder: boolean;
  /** Pass the last item's sequence as `after` for more. */
  readonly hasNewer: boolean;
  readonly lastReadSequence: number;
  /** Names for every sender on this page — one lookup, not one per bubble. */
  readonly senders: readonly PersonView[];
}

export interface ParticipantView {
  readonly userId: string;
  readonly displayName: string | null;
  readonly role: ParticipantRole;
  readonly joinedAt: Date;
}
