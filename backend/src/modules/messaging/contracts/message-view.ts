import type { FileAssetSummary } from '../../files/contracts/file-assets';
import type { MessageType } from './vocabulary';

/** A file on a message. `file` is null once the file is no longer available. */
export interface AttachmentView {
  readonly fileAssetId: string;
  readonly file: FileAssetSummary | null;
}

/**
 * A message as a member of its conversation sees it — the one shape every
 * delivery path uses (the HTTP timeline, the send response, realtime). No
 * storage key, no URL: a file is a reference, and a link to it is asked for
 * separately, by someone messaging has authorized.
 */
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
