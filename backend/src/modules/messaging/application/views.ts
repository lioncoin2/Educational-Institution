import type { FileAssetSummary } from '../../files/contracts/file-assets';
import type { ConversationType, MessageType, ParticipantRole } from '../contracts/vocabulary';

/** A file on a message. `file` is null once the file is no longer available. */
export interface AttachmentView {
  readonly fileAssetId: string;
  readonly file: FileAssetSummary | null;
}

export interface MessageView {
  readonly id: string;
  readonly conversationId: string;
  /** The order. Also the pagination cursor. */
  readonly sequence: number;
  readonly senderId: string;
  readonly type: MessageType;
  /** Null for a deleted message (a tombstone) and for media without a caption. */
  readonly body: string | null;
  readonly replyToMessageId: string | null;
  /** Only on the viewer's own messages: how their other devices reconcile a send. */
  readonly clientMessageId: string | null;
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly attachments: readonly AttachmentView[];
}

export interface PersonView {
  readonly userId: string;
  readonly displayName: string;
}

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
