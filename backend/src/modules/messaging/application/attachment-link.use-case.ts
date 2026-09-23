import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Principal, type Result } from '../../../shared';
import { FILE_ASSETS, type DownloadLink, type FileAssets } from '../../files/contracts/file-assets';
import { Permissions } from '../../identity/contracts/permissions';
import type { MessageId } from '../domain/message';
import { canSee } from '../domain/participant';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { ConversationAccess } from './conversation-access';

const NOT_FOUND = failure('not_found', 'messaging.attachment_not_found', 'No such attachment.');

/**
 * A short-lived link to a file on a message — the only way to read one.
 *
 * Files cannot know who may read a voice message; messaging can: a current
 * member of the conversation, who can see that message (their visibility
 * window), holding `messaging.read` and `files.read`, asking for a file that
 * really is attached to it. Only then is Files asked to mint a link.
 */
@Injectable()
export class GetAttachmentLinkUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
  ) {}

  async execute(query: {
    readonly principal: Principal;
    readonly conversationId: string;
    readonly messageId: string;
    readonly fileAssetId: string;
  }): Promise<Result<DownloadLink>> {
    const readsFiles = this.access.authorize(query.principal, Permissions.files.read);
    if (!readsFiles.ok) return readsFiles;
    const membership = await this.access.member(
      query.principal,
      query.conversationId,
      Permissions.messaging.read,
    );
    if (!membership.ok) return membership;
    const { conversation, participant } = membership.value;

    const message = await this.repository.findMessage(
      conversation.id,
      query.messageId as MessageId,
    );
    if (
      message === null ||
      message.deletedAt !== null ||
      !canSee(participant, message.sequence) ||
      !message.attachments.some((attachment) => attachment.fileAssetId === query.fileAssetId)
    ) {
      return err(NOT_FOUND);
    }

    const link = await this.files.createDownloadLink(query.fileAssetId);
    return link.ok ? ok(link.value) : err(NOT_FOUND);
  }
}
