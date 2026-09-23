import type { DownloadLink } from '../../files/contracts/file-assets';
import type { FileKind } from '../../files/contracts/file-kind';
import type { ConversationType, MessageType, ParticipantRole } from '../contracts/vocabulary';
import type {
  AttachmentView,
  ConversationView,
  MessagePage,
  MessagePreview,
  MessageView,
  ParticipantView,
  PersonView,
} from '../application/views';

/** Wire shapes: explicit, flat, ISO-8601 instants. */

export interface AttachmentResponse {
  readonly fileAssetId: string;
  /** False once the file is gone (e.g. retention); the fields below are then null. */
  readonly available: boolean;
  readonly kind: FileKind | null;
  readonly contentType: string | null;
  readonly byteSize: number | null;
  readonly displayName: string | null;
  readonly durationMs: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface MessageResponse {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly senderId: string;
  readonly type: MessageType;
  readonly body: string | null;
  readonly replyToMessageId: string | null;
  readonly clientMessageId: string | null;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
  readonly attachments: readonly AttachmentResponse[];
}

export interface MessagePageResponse {
  readonly items: readonly MessageResponse[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly lastReadSequence: number;
  readonly senders: readonly PersonView[];
}

export interface MessagePreviewResponse {
  readonly sequence: number;
  readonly senderId: string;
  readonly senderName: string | null;
  readonly type: MessageType;
  readonly text: string | null;
  readonly deleted: boolean;
  readonly createdAt: string;
}

export interface ConversationResponse {
  readonly id: string;
  readonly type: ConversationType;
  readonly title: string | null;
  readonly counterpartUserId: string | null;
  readonly memberCount: number;
  readonly myRole: ParticipantRole;
  readonly canPost: boolean;
  readonly canManageMembers: boolean;
  readonly lastSequence: number;
  readonly lastReadSequence: number;
  readonly unreadCount: number;
  readonly lastMessage: MessagePreviewResponse | null;
  readonly createdAt: string;
  readonly activityAt: string;
}

export interface ParticipantResponse {
  readonly userId: string;
  readonly displayName: string | null;
  readonly role: ParticipantRole;
  readonly joinedAt: string;
}

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

function toAttachmentResponse(attachment: AttachmentView): AttachmentResponse {
  const file = attachment.file;
  return {
    fileAssetId: attachment.fileAssetId,
    available: file !== null,
    kind: file?.kind ?? null,
    contentType: file?.contentType ?? null,
    byteSize: file?.byteSize ?? null,
    displayName: file?.displayName ?? null,
    durationMs: file?.durationMs ?? null,
    width: file?.width ?? null,
    height: file?.height ?? null,
  };
}

export function toMessageResponse(message: MessageView): MessageResponse {
  return {
    id: message.id,
    conversationId: message.conversationId,
    sequence: message.sequence,
    senderId: message.senderId,
    type: message.type,
    body: message.body,
    replyToMessageId: message.replyToMessageId,
    clientMessageId: message.clientMessageId,
    createdAt: message.createdAt.toISOString(),
    editedAt: iso(message.editedAt),
    deletedAt: iso(message.deletedAt),
    attachments: message.attachments.map(toAttachmentResponse),
  };
}

export function toMessagePageResponse(page: MessagePage): MessagePageResponse {
  return {
    items: page.items.map(toMessageResponse),
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
    lastReadSequence: page.lastReadSequence,
    senders: page.senders,
  };
}

function toPreviewResponse(preview: MessagePreview): MessagePreviewResponse {
  return { ...preview, createdAt: preview.createdAt.toISOString() };
}

export function toConversationResponse(view: ConversationView): ConversationResponse {
  return {
    ...view,
    lastMessage: view.lastMessage === null ? null : toPreviewResponse(view.lastMessage),
    createdAt: view.createdAt.toISOString(),
    activityAt: view.activityAt.toISOString(),
  };
}

export function toParticipantResponse(participant: ParticipantView): ParticipantResponse {
  return { ...participant, joinedAt: participant.joinedAt.toISOString() };
}

export function toLinkResponse(link: DownloadLink): { url: string; expiresAt: string } {
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
}
