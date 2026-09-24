import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  EVENT_PUBLISHER,
  ID_GENERATOR,
  RATE_LIMITER,
  err,
  failure,
  ok,
  type CallMetadata,
  type Clock,
  type EventPublisher,
  type Failure,
  type IdGenerator,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import { FILE_ASSETS, type FileAssets } from '../../files/contracts/file-assets';
import { Permissions } from '../../identity/contracts/permissions';
import type { MessageType } from '../contracts/vocabulary';
import type { ConversationId } from '../domain/conversation';
import { messageSent } from '../domain/events';
import {
  ACCEPTED_FILE_KINDS,
  mediaDraft,
  textDraft,
  type Message,
  type MessageDraft,
  type MessageId,
} from '../domain/message';
import { canPost, canSee } from '../domain/participant';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { CommunityChats } from './community-chats';
import { CONVERSATION_NOT_FOUND, ConversationAccess, type Membership } from './conversation-access';
import { SENDS_PER_USER } from './messaging-settings';
import { MessagingViews } from './messaging-views';
import type { MessageView } from './views';

export interface SentMessage {
  readonly message: MessageView;
  /** False when this was a retry of a send that had already succeeded. */
  readonly created: boolean;
}

interface CommonSend {
  readonly principal: Principal;
  readonly conversationId: string;
  /** The client's idempotency key — resend it verbatim on every retry. */
  readonly clientMessageId: string;
  readonly replyToMessageId?: string | null;
  readonly meta: CallMetadata;
}

export type SendTextCommand = CommonSend & { readonly body: string };

export type SendMediaCommand = CommonSend & {
  /** An upload the sender completed (see POST /files/uploads). */
  readonly fileAssetId: string;
  readonly caption?: string | null;
};

/**
 * The one path every message takes into a conversation. The typed use cases
 * below differ only in the draft they build and the files they accept.
 *
 * In order — cheapest refusals first:
 *   1. `messaging.send`, then the rate limit;
 *   2. the draft is well-formed (key, body, caption);
 *   3. the sender is a current member, and may post here (channels: owner
 *      and publishers only; a community chat: whoever Communities permits
 *      `community.chat.post` now, within the capacity switch);
 *   4. a reply points at a message in THIS conversation that the sender can see;
 *   5. an attachment is the sender's own, verified upload of an accepted kind;
 *   6. the append — which re-checks membership under the conversation lock,
 *      resolves the idempotency key, and assigns the sequence.
 *
 * Only a newly stored message raises `messaging.message.sent`; a retry
 * returns the original and raises nothing.
 */
@Injectable()
export class MessageSender {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
    private readonly views: MessagingViews,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly communityChats: CommunityChats,
  ) {}

  async send(
    command: CommonSend,
    build: (base: {
      readonly id: MessageId;
      readonly conversationId: ConversationId;
      readonly senderId: string;
      readonly clientMessageId: string;
      readonly replyToMessageId: MessageId | null;
      readonly at: Date;
    }) => Result<MessageDraft>,
  ): Promise<Result<SentMessage>> {
    const { principal } = command;
    const allowed = this.access.authorize(
      principal,
      Permissions.messaging.send,
      command.conversationId,
    );
    if (!allowed.ok) return allowed;

    const throttle = await this.limiter.consume(principal.userId, SENDS_PER_USER);
    if (!throttle.allowed) {
      return err(
        failure('rate_limited', 'messaging.too_many_messages', 'Too many messages. Slow down.', {
          retryAfterSeconds: throttle.retryAfterSeconds,
        }),
      );
    }

    const draft = build({
      id: this.ids.next<'Message'>(),
      conversationId: command.conversationId as ConversationId,
      senderId: principal.userId,
      clientMessageId: command.clientMessageId,
      replyToMessageId: (command.replyToMessageId ?? null) as MessageId | null,
      at: this.clock.now(),
    });
    if (!draft.ok) return draft;

    const membership = await this.access.member(
      principal,
      command.conversationId,
      Permissions.messaging.send,
    );
    if (!membership.ok) return membership;
    const { conversation, participant } = membership.value;
    if (conversation.communityId !== null) {
      // Communities' rule, asked now; the projected role is never consulted.
      const posting = await this.communityChats.mayPost(principal, conversation);
      if (!posting.ok) return posting;
    } else if (!canPost(conversation.type, participant.role)) {
      return err(
        failure(
          'forbidden',
          'messaging.posting_not_allowed',
          'Only the owner and publishers may post in this channel.',
        ),
      );
    }

    const reply = await this.checkReply(membership.value, draft.value.replyToMessageId);
    if (!reply.ok) return reply;
    const attachments = await this.checkAttachments(principal.userId, draft.value);
    if (!attachments.ok) return attachments;

    const outcome = await this.repository.appendMessage(draft.value);
    switch (outcome.kind) {
      case 'not_participant':
        // Removed between the membership check and the append: the lock
        // decided, and the removal came first.
        return err(CONVERSATION_NOT_FOUND);
      case 'key_reused':
        return err(
          failure(
            'conflict',
            'messaging.client_message_id_reused',
            'This clientMessageId was already used for a different message.',
          ),
        );
      case 'duplicate':
        return ok({ message: await this.view(outcome.message, principal.userId), created: false });
      case 'appended':
        await this.events.publish([
          messageSent(conversation, outcome.message, command.meta.correlationId),
        ]);
        return ok({ message: await this.view(outcome.message, principal.userId), created: true });
    }
  }

  private async checkReply(
    membership: Membership,
    replyToMessageId: MessageId | null,
  ): Promise<Result<void>> {
    if (replyToMessageId === null) return ok(undefined);
    const target = await this.repository.findMessage(membership.conversation.id, replyToMessageId);
    // Another conversation's message, or one from before the sender joined,
    // is "not found" — a reply must not become a way to learn it exists.
    if (target === null || !canSee(membership.participant, target.sequence)) {
      return err(
        failure(
          'validation',
          'messaging.reply_target_not_found',
          'The message being replied to is not in this conversation.',
        ),
      );
    }
    return ok(undefined);
  }

  private async checkAttachments(senderId: string, draft: MessageDraft): Promise<Result<void>> {
    if (draft.type === 'TEXT') return ok(undefined);
    const accepted = ACCEPTED_FILE_KINDS[draft.type];
    for (const attachment of draft.attachments) {
      const verified = await this.files.verifyAttachable(
        attachment.fileAssetId,
        senderId,
        accepted,
      );
      if (!verified.ok) return err(attachmentFailure(verified.error));
    }
    return ok(undefined);
  }

  private async view(message: Message, viewerId: string): Promise<MessageView> {
    const rendered = await this.views.messages([message], viewerId);
    const view = rendered.items[0];
    if (view === undefined) throw new Error('A rendered message went missing.');
    return view;
  }
}

/** Files' refusals, restated in messaging's words: the send is what failed. */
function attachmentFailure(cause: Failure): Failure {
  switch (cause.code) {
    case 'files.asset_not_ready':
      return failure(
        'precondition_failed',
        'messaging.attachment_not_ready',
        'The attachment has not finished uploading.',
      );
    case 'files.asset_kind_not_accepted':
      return failure(
        'validation',
        'messaging.attachment_kind_invalid',
        'That kind of file cannot be sent as this message type.',
        cause.details,
      );
    default:
      // Missing, or someone else's upload — the same answer for both.
      return failure(
        'validation',
        'messaging.attachment_not_found',
        'The attachment does not exist.',
      );
  }
}

@Injectable()
export class SendTextMessageUseCase {
  constructor(private readonly sender: MessageSender) {}

  execute(command: SendTextCommand): Promise<Result<SentMessage>> {
    return this.sender.send(command, (base) => textDraft({ ...base, body: command.body }));
  }
}

@Injectable()
abstract class SendMediaMessage {
  protected abstract readonly type: Exclude<MessageType, 'TEXT'>;

  constructor(private readonly sender: MessageSender) {}

  execute(command: SendMediaCommand): Promise<Result<SentMessage>> {
    return this.sender.send(command, (base) =>
      mediaDraft({
        ...base,
        type: this.type,
        fileAssetId: command.fileAssetId,
        caption: command.caption ?? null,
      }),
    );
  }
}

/** A recorded voice message: one VOICE file, asynchronous — not a live call. */
@Injectable()
export class SendVoiceMessageUseCase extends SendMediaMessage {
  protected readonly type = 'VOICE' as const;
}

@Injectable()
export class SendImageMessageUseCase extends SendMediaMessage {
  protected readonly type = 'IMAGE' as const;
}

/** A document or an audio file (a recitation recording, say). */
@Injectable()
export class SendFileMessageUseCase extends SendMediaMessage {
  protected readonly type = 'FILE' as const;
}
