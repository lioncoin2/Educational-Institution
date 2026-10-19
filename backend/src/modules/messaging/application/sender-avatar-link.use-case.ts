import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Principal, type Result } from '../../../shared';
import { FILE_ASSETS, type DownloadLink, type FileAssets } from '../../files/contracts/file-assets';
import {
  ACCOUNT_DIRECTORY,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import type { FileKind } from '../../files/contracts/file-kind';
import { Permissions } from '../../identity/contracts/permissions';
import type { MessageId } from '../domain/message';
import { canSee } from '../domain/participant';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { ConversationAccess } from './conversation-access';

const NO_AVATAR = failure('not_found', 'messaging.sender_avatar_not_found', 'No sender picture.');
const AVATAR_KINDS: readonly FileKind[] = ['IMAGE'];

/**
 * A short-lived link to the picture of the person who sent a message.
 *
 * Scoped to a message, exactly like an attachment link: the sender is the
 * message's own `senderId`, so there is no untrusted id to authorize — a
 * current member who can see the message may see who it is from, which is the
 * picture as much as the name. (Identity resolves the picture reference the
 * same way it resolves the name, through the directory messaging already uses.)
 * Files then verifies the asset is an image that sender owns before minting the
 * link, so a reference the sender has since cleared or replaced cannot leak
 * anything. No picture, or a sender who is gone, reads as "no sender picture".
 */
@Injectable()
export class GetSenderAvatarLinkUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
  ) {}

  async execute(query: {
    readonly principal: Principal;
    readonly conversationId: string;
    readonly messageId: string;
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
    if (message === null || message.deletedAt !== null || !canSee(participant, message.sequence)) {
      return err(NO_AVATAR);
    }

    const [sender] = await this.directory.describe([message.senderId]);
    if (sender === undefined || sender.avatarFileAssetId === null) return err(NO_AVATAR);

    // The reference is only turned into a link once Files confirms it is still
    // an image that sender owns — so a stale or swapped reference cannot leak.
    const verified = await this.files.verifyAttachable(
      sender.avatarFileAssetId,
      message.senderId,
      AVATAR_KINDS,
    );
    if (!verified.ok) return err(NO_AVATAR);

    const link = await this.files.createDownloadLink(sender.avatarFileAssetId);
    return link.ok ? ok(link.value) : err(NO_AVATAR);
  }
}
