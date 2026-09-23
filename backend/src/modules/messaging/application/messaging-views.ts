import { Inject, Injectable } from '@nestjs/common';

import { FILE_ASSETS, type FileAssets } from '../../files/contracts/file-assets';
import {
  ACCOUNT_DIRECTORY,
  ACCOUNT_DIRECTORY_MAX_IDS,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import { asSeen, type Message } from '../domain/message';
import { canManageMembers, canPost, type Participant } from '../domain/participant';
import type { ConversationSummaryRow, MessageHead } from '../domain/ports';
import type {
  ConversationView,
  MessagePreview,
  MessageView,
  ParticipantView,
  PersonView,
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

  async conversations(rows: readonly ConversationSummaryRow[]): Promise<ConversationView[]> {
    const names = await this.names(
      rows.flatMap((row) => [row.counterpartUserId, row.lastMessage?.senderId ?? null]),
    );
    return rows.map((row) => {
      const { conversation, me } = row;
      const counterpart = row.counterpartUserId;
      return {
        id: conversation.id,
        type: conversation.type,
        title:
          conversation.type === 'DIRECT'
            ? counterpart === null
              ? null
              : (names.get(counterpart) ?? null)
            : conversation.title,
        counterpartUserId: counterpart,
        memberCount: conversation.memberCount,
        myRole: me.role,
        canPost: canPost(conversation.type, me.role),
        canManageMembers: canManageMembers(conversation.type, me.role),
        lastSequence: conversation.lastSequence,
        lastReadSequence: me.lastReadSequence,
        unreadCount: row.unreadCount,
        lastMessage: row.lastMessage === null ? null : preview(row.lastMessage, names),
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
    const [files, names] = await Promise.all([
      assetIds.length === 0 ? Promise.resolve([]) : this.files.describe([...new Set(assetIds)]),
      this.names(seen.map((message) => message.senderId)),
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
      senders: [...names].map(([userId, displayName]) => ({ userId, displayName })),
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

  /** Display names for these ids, in as few directory calls as the cap allows. */
  private async names(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    const names = new Map<string, string>();
    for (let start = 0; start < unique.length; start += ACCOUNT_DIRECTORY_MAX_IDS) {
      const chunk = unique.slice(start, start + ACCOUNT_DIRECTORY_MAX_IDS);
      for (const account of await this.directory.describe(chunk)) {
        names.set(account.userId, account.displayName);
      }
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
