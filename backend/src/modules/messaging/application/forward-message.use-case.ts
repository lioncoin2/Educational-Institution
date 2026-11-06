import { Inject, Injectable } from '@nestjs/common';

import { err, failure, type CallMetadata, type Principal, type Result } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { forwardDraft, type MessageId } from '../domain/message';
import { canSee } from '../domain/participant';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { ConversationAccess } from './conversation-access';
import { MessageSender, type SentMessage } from './send-message.use-cases';

/**
 * A source message that is not the forwarder's to read is reported exactly like
 * a missing one — forwarding must never become a way to learn a message exists.
 */
const SOURCE_NOT_FOUND = failure(
  'not_found',
  'messaging.forward_source_not_found',
  'The message being forwarded does not exist.',
);

/**
 * Forward a message into another conversation (Telegram-style).
 *
 * Two authorizations, in order:
 *   1. the forwarder may READ the SOURCE: a current member of the source
 *      conversation (`messaging.read`) who can SEE that message (their
 *      visibility window), and the message is live (not a tombstone);
 *   2. the forwarder may POST in the TARGET: the ordinary send path handles it
 *      (membership, channel/community posting rule, rate limit, idempotency,
 *      the `messaging.message.sent` event).
 *
 * The copy carries the source's type, body and attachment REFERENCES verbatim
 * (the same file assets — safe, because a reader of the target is authorized
 * for its attachments by membership, never by owning the file) and the ORIGINAL
 * author's id. Forwarding a forward keeps the first origin. A forward is never a
 * reply. Because the attachments come from an authorized read, the send is told
 * not to re-check their ownership (which could only reject them).
 */
@Injectable()
export class ForwardMessageUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    private readonly sender: MessageSender,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    /** Where the forward is posted. */
    readonly targetConversationId: string;
    readonly clientMessageId: string;
    readonly sourceConversationId: string;
    readonly sourceMessageId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<SentMessage>> {
    const source = await this.access.member(
      command.principal,
      command.sourceConversationId,
      Permissions.messaging.read,
    );
    if (!source.ok) return source;

    const message = await this.repository.findMessage(
      source.value.conversation.id,
      command.sourceMessageId as MessageId,
    );
    if (
      message === null ||
      message.deletedAt !== null ||
      !canSee(source.value.participant, message.sequence)
    ) {
      return err(SOURCE_NOT_FOUND);
    }

    const origin = message.forwardedFromSenderId ?? message.senderId;
    return this.sender.send(
      {
        principal: command.principal,
        conversationId: command.targetConversationId,
        clientMessageId: command.clientMessageId,
        meta: command.meta,
      },
      (base) =>
        forwardDraft({
          ...base,
          type: message.type,
          body: message.body,
          attachments: message.attachments,
          forwardedFromSenderId: origin,
        }),
      { attachmentsAlreadyAuthorized: true },
    );
  }
}
