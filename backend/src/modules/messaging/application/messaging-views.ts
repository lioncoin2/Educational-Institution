import { Inject, Injectable } from '@nestjs/common';

import { FILE_ASSETS, type FileAssets } from '../../files/contracts/file-assets';
import {
  ACCOUNT_DIRECTORY,
  ACCOUNT_DIRECTORY_MAX_IDS,
  type AccountDirectory,
  type AccountSummary,
} from '../../identity/contracts/account-directory';
import { asSeen, type Message } from '../domain/message';
import { canManageMembers, canPost, type Participant } from '../domain/participant';
import type { ConversationSummaryRow, MessageHead } from '../domain/ports';
import type { CommunityChatDetails } from './community-chats';
import type {
  ConversationView,
  MessagePreview,
  MessageView,
  ParticipantView,
  PersonView,
  ReviewedMessageView,
} from './views';

const PREVIEW_LENGTH = 140;

/**
 * Turns stored rows into what a viewer sees. Every cross-module lookup is
 * batched per page — one directory call for all the names, one files call
 * for all the attachments — so rendering never multiplies queries by the
 * number of rows.
 */
@Injectable()
export class MessagingViews {
  constructor(
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
  ) {}

  /**
   * `communityChats` carries what Communities says about the community chats
   * among the rows (title, posting); a community chat without an entry shows
   * no title and cannot be posted to — the fail-closed default.
   */
  async conversations(
    rows: readonly ConversationSummaryRow[],
    communityChats: ReadonlyMap<string, CommunityChatDetails> = new Map(),
  ): Promise<ConversationView[]> {
    const names = await this.names(
      rows.flatMap((row) => [row.counterpartUserId, row.lastMessage?.senderId ?? null]),
    );
    return rows.map((row) => {
      const { conversation, me } = row;
      const counterpart = row.counterpartUserId;
      const community =
        conversation.communityId === null
          ? null
          : (communityChats.get(conversation.id) ?? { title: null, canPost: false, kind: null });
      return {
        id: conversation.id,
        type: conversation.type,
        communityId: conversation.communityId,
        // A community chat's product kind (GROUP/CHANNEL) for the header; the
        // `type` above stays CHANNEL for every community chat (Q51). Null for a
        // direct/standalone conversation, or when Communities could not be asked.
        communityKind: community !== null ? community.kind : null,
        title:
          community !== null
            ? community.title
            : conversation.type === 'DIRECT'
              ? counterpart === null
                ? null
                : (names.get(counterpart) ?? null)
              : conversation.title,
        counterpartUserId: counterpart,
        memberCount: conversation.memberCount,
        // A community chat's row is always a plain MEMBER: roles there are Communities'.
        myRole: community !== null ? 'MEMBER' : me.role,
        canPost: community !== null ? community.canPost : canPost(conversation.type, me.role),
        canManageMembers: community !== null ? false : canManageMembers(conversation.type, me.role),
        lastSequence: conversation.lastSequence,
        lastReadSequence: me.lastReadSequence,
        unreadCount: row.unreadCount,
        lastMessage: row.lastMessage === null ? null : preview(row.lastMessage, names),
        pinnedMessageId: conversation.pinnedMessageId,
        pinVersion: conversation.pinVersion,
        createdAt: conversation.createdAt,
        activityAt: conversation.lastMessageAt ?? conversation.createdAt,
      };
    });
  }

  async messages(
    messages: readonly Message[],
    viewerId: string,
  ): Promise<{ items: MessageView[]; senders: PersonView[] }> {
    const seen = messages.map(asSeen);
    const assetIds = seen.flatMap((message) => message.attachments.map((a) => a.fileAssetId));
    const [files, senders] = await Promise.all([
      assetIds.length === 0 ? Promise.resolve([]) : this.files.describe([...new Set(assetIds)]),
      this.summaries(seen.map((message) => message.senderId)),
    ]);
    const fileById = new Map(files.map((file) => [file.id, file]));

    return {
      items: seen.map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        sequence: message.sequence,
        senderId: message.senderId,
        type: message.type,
        body: message.body,
        replyToMessageId: message.replyToMessageId,
        clientMessageId: message.senderId === viewerId ? message.clientMessageId : null,
        createdAt: message.createdAt,
        editedAt: message.editedAt,
        deletedAt: message.deletedAt,
        attachments: message.attachments.map((attachment) => ({
          fileAssetId: attachment.fileAssetId,
          file: fileById.get(attachment.fileAssetId) ?? null,
        })),
      })),
      senders: [...senders.values()].map((account) => ({
        userId: account.userId,
        displayName: account.displayName,
        avatarFileAssetId: account.avatarFileAssetId,
      })),
    };
  }

  /**
   * A deleted message's ORIGINAL, for the audited moderation review (Q51/Q23)
   * — deliberately WITHOUT `asSeen`, the one render that reveals a tombstone's
   * body, attachments and the moderator who deleted it. Every other path keeps
   * `asSeen`; this one is reached only after `community.messages.moderate` and
   * the review-window check. Throws if handed a message that is not deleted,
   * so it can never be a second way to render a live message.
   */
  async reviewed(message: Message): Promise<ReviewedMessageView> {
    if (message.deletedAt === null || message.deletedBy === null) {
      throw new Error('Only a deleted message is reviewed.');
    }
    const assetIds = message.attachments.map((attachment) => attachment.fileAssetId);
    const [files, names] = await Promise.all([
      assetIds.length === 0 ? Promise.resolve([]) : this.files.describe([...new Set(assetIds)]),
      this.names([message.senderId, message.deletedBy]),
    ]);
    const fileById = new Map(files.map((file) => [file.id, file]));
    return {
      id: message.id,
      conversationId: message.conversationId,
      sequence: message.sequence,
      senderId: message.senderId,
      senderName: names.get(message.senderId) ?? null,
      type: message.type,
      body: message.body,
      replyToMessageId: message.replyToMessageId,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      deletedAt: message.deletedAt,
      deletedBy: message.deletedBy,
      deletedByName: names.get(message.deletedBy) ?? null,
      attachments: message.attachments.map((attachment) => ({
        fileAssetId: attachment.fileAssetId,
        file: fileById.get(attachment.fileAssetId) ?? null,
      })),
    };
  }

  async participants(participants: readonly Participant[]): Promise<ParticipantView[]> {
    const names = await this.names(participants.map((participant) => participant.userId));
    return participants.map((participant) => ({
      userId: participant.userId,
      displayName: names.get(participant.userId) ?? null,
      role: participant.role,
      joinedAt: participant.joinedAt,
    }));
  }

  /** Account summaries for these ids, in as few directory calls as the cap allows. */
  private async summaries(ids: readonly (string | null)[]): Promise<Map<string, AccountSummary>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    const summaries = new Map<string, AccountSummary>();
    for (let start = 0; start < unique.length; start += ACCOUNT_DIRECTORY_MAX_IDS) {
      const chunk = unique.slice(start, start + ACCOUNT_DIRECTORY_MAX_IDS);
      for (const account of await this.directory.describe(chunk)) {
        summaries.set(account.userId, account);
      }
    }
    return summaries;
  }

  /** Display names only — the same one directory call, for paths that show no picture. */
  private async names(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const [userId, account] of await this.summaries(ids)) {
      names.set(userId, account.displayName);
    }
    return names;
  }
}

function preview(message: MessageHead, names: ReadonlyMap<string, string>): MessagePreview {
  const deleted = message.deletedAt !== null;
  const text =
    deleted || message.body === null ? null : [...message.body].slice(0, PREVIEW_LENGTH).join('');
  return {
    sequence: message.sequence,
    senderId: message.senderId,
    senderName: names.get(message.senderId) ?? null,
    type: message.type,
    text,
    deleted,
    createdAt: message.createdAt,
  };
}
