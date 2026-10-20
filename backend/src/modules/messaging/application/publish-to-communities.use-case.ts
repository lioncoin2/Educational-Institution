import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  err,
  failure,
  ok,
  type CallMetadata,
  type Clock,
  type Failure,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../shared';
import {
  COMMUNITY_AUTHORIZATION,
  type CommunityAuthorization,
} from '../../communities/contracts/authorization';
import { FILE_ASSETS, type FileAssets } from '../../files/contracts/file-assets';
import type { Conversation } from '../domain/conversation';
import { ACCEPTED_FILE_KINDS } from '../domain/message';
import {
  MESSAGING_READ_MODEL,
  MESSAGING_REPOSITORY,
  type MessagingReadModel,
  type MessagingRepository,
} from '../domain/ports';
import {
  SendFileMessageUseCase,
  SendImageMessageUseCase,
  SendTextMessageUseCase,
  SendVoiceMessageUseCase,
  type SentMessage,
} from './send-message.use-cases';

/**
 * The most communities one publish may target at once. A publish is N ordinary
 * community-chat sends, so this stays well under `SENDS_PER_USER` (120/60s): a
 * single full batch never trips the sender's own rate limit. A membership
 * limit it is not — it bounds one request, never a community's size.
 */
export const MAX_PUBLISH_TARGETS = 50;

export type PublicationKind = 'TEXT' | 'IMAGE' | 'VOICE' | 'FILE';

/**
 * Per community, what happened — the vocabulary the client shows and retries by.
 *
 *   posted          a new message was stored
 *   already_posted  this exact publish had already reached this community (an
 *                   idempotent retry, by the batch's deterministic key) — no duplicate
 *   forbidden       the viewer may not post in this community (no capability/ceiling)
 *   not_found       no such community, or the viewer is not a member (one answer)
 *   locked          the community's lifecycle has posting closed
 *   over_capacity   the chat is larger than posting is served for yet
 *   rate_limited    the sender's own throttle tripped mid-batch
 *   unavailable     a service was briefly unreachable
 *   failed          an unexpected refusal (not retried blindly)
 */
export type PublicationStatus =
  | 'posted'
  | 'already_posted'
  | 'forbidden'
  | 'not_found'
  | 'locked'
  | 'over_capacity'
  | 'rate_limited'
  | 'unavailable'
  | 'failed';

export interface PublicationOutcome {
  readonly communityId: string;
  readonly status: PublicationStatus;
  /** True only for transient refusals a plain retry can clear. */
  readonly retryable: boolean;
  readonly messageId: string | null;
}

export interface PublicationReport {
  readonly batchId: string;
  readonly results: readonly PublicationOutcome[];
}

export interface PublishCommand {
  readonly principal: Principal;
  /** The client's idempotency key for the whole batch; resend it verbatim to retry. */
  readonly clientBatchId: string;
  readonly communityIds: readonly string[];
  readonly kind: PublicationKind;
  /** The text of a TEXT publish, or the caption of a media one. */
  readonly body?: string | null;
  /** A completed upload of the sender's own (POST /files/uploads, then …/complete). Media kinds only. */
  readonly fileAssetId?: string | null;
  readonly meta: CallMetadata;
}

type PublishContent =
  | { readonly type: 'TEXT'; readonly body: string }
  | {
      readonly type: 'IMAGE' | 'VOICE' | 'FILE';
      readonly fileAssetId: string;
      readonly caption: string | null;
    };

/**
 * Publish one file/image/voice recording — or a text notice — to several
 * communities at once (the owner's "النشر الجماعي"), authorizing each community
 * on its own and reporting each community's outcome so the client can retry only
 * what transiently failed.
 *
 * It invents nothing: each target receives an ORDINARY community-chat message
 * from this real sender, through the one `MessageSender` path, so the per-
 * community `community.chat.post` gate, the capacity switch, the attachment
 * checks and the existing delivery/notification behaviour all apply unchanged.
 * There is no "announcement", no priority send, no cross-community audience —
 * only the same post, authorized and delivered once per community.
 *
 * In order:
 *   1. the batch is shaped (targets deduped, ≤ MAX_PUBLISH_TARGETS; content well-formed);
 *   2. a media attachment is verified ONCE — a bad upload fails the whole
 *      publish before anything is posted (a request-level error, not a per-
 *      community one);
 *   3. every target is authorized in one `authorizeEach(community.chat.post)` —
 *      no chat is materialized for a community the viewer may not post in;
 *   4. each authorized target is posted to, with a clientMessageId derived from
 *      the batch id and the community id, so a retry of a community that already
 *      received the post returns the original (idempotent), never a duplicate.
 *
 * The overall result is `ok` whenever the request was well-formed; a community
 * that could not be posted to is a per-community outcome, never a thrown batch.
 */
@Injectable()
export class PublishToCommunitiesUseCase {
  constructor(
    @Inject(COMMUNITY_AUTHORIZATION) private readonly authorization: CommunityAuthorization,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly sendText: SendTextMessageUseCase,
    private readonly sendVoice: SendVoiceMessageUseCase,
    private readonly sendImage: SendImageMessageUseCase,
    private readonly sendFile: SendFileMessageUseCase,
  ) {}

  async execute(command: PublishCommand): Promise<Result<PublicationReport>> {
    const targets = [...new Set(command.communityIds)];
    if (targets.length === 0) {
      return err(
        failure(
          'validation',
          'messaging.publish_no_targets',
          'Name at least one community to publish to.',
        ),
      );
    }
    if (targets.length > MAX_PUBLISH_TARGETS) {
      return err(
        failure(
          'validation',
          'messaging.publish_too_many_targets',
          `A publish targets at most ${MAX_PUBLISH_TARGETS} communities at once.`,
          { max: MAX_PUBLISH_TARGETS },
        ),
      );
    }

    const content = this.contentOf(command);
    if (!content.ok) return content;

    if (content.value.type !== 'TEXT') {
      const verified = await this.files.verifyAttachable(
        content.value.fileAssetId,
        command.principal.userId,
        ACCEPTED_FILE_KINDS[content.value.type],
      );
      if (!verified.ok) return err(attachmentFailure(verified.error));
    }

    const permits = await this.authorization.authorizeEach(
      command.principal,
      targets,
      'community.chat.post',
    );

    const results: PublicationOutcome[] = [];
    for (const communityId of targets) {
      const permit = permits.get(communityId);
      if (permit === undefined || !permit.ok) {
        const reason = permit === undefined ? UNAVAILABLE : permit.error;
        const { status, retryable } = classify(reason);
        results.push({ communityId, status, retryable, messageId: null });
        continue;
      }
      results.push(await this.publishOne(command, content.value, communityId));
    }

    return ok({ batchId: command.clientBatchId, results });
  }

  private contentOf(command: PublishCommand): Result<PublishContent> {
    if (command.kind === 'TEXT') {
      if ((command.body ?? '').trim().length === 0) {
        return err(
          failure(
            'validation',
            'messaging.publish_body_required',
            'A text publication needs a body.',
          ),
        );
      }
      return ok({ type: 'TEXT', body: command.body as string });
    }
    const fileAssetId = command.fileAssetId ?? '';
    if (fileAssetId.length === 0) {
      return err(
        failure(
          'validation',
          'messaging.publish_attachment_required',
          'A file, image or audio publication needs a fileAssetId.',
        ),
      );
    }
    return ok({ type: command.kind, fileAssetId, caption: command.body ?? null });
  }

  private async publishOne(
    command: PublishCommand,
    content: PublishContent,
    communityId: string,
  ): Promise<PublicationOutcome> {
    const conversation = await this.resolveChat(communityId);
    const base = {
      principal: command.principal,
      conversationId: conversation.id,
      clientMessageId: batchKey(command.clientBatchId, communityId),
      replyToMessageId: null,
      meta: command.meta,
    };

    let result: Result<SentMessage>;
    switch (content.type) {
      case 'TEXT':
        result = await this.sendText.execute({ ...base, body: content.body });
        break;
      case 'IMAGE':
        result = await this.sendImage.execute({
          ...base,
          fileAssetId: content.fileAssetId,
          caption: content.caption,
        });
        break;
      case 'VOICE':
        result = await this.sendVoice.execute({
          ...base,
          fileAssetId: content.fileAssetId,
          caption: content.caption,
        });
        break;
      case 'FILE':
        result = await this.sendFile.execute({
          ...base,
          fileAssetId: content.fileAssetId,
          caption: content.caption,
        });
        break;
    }

    if (!result.ok) {
      const { status, retryable } = classify(result.error);
      return { communityId, status, retryable, messageId: null };
    }
    return {
      communityId,
      status: result.value.created ? 'posted' : 'already_posted',
      retryable: false,
      messageId: result.value.message.id,
    };
  }

  /**
   * The community's chat conversation, materialized if it has none yet — the
   * same resolution opening the chat does, minus the read-path rate limit the
   * open imposes to slow probing: here the caller has already been authorized to
   * POST in this very community, so the conversation must exist to receive it.
   */
  private async resolveChat(communityId: string): Promise<Conversation> {
    const known = await this.readModel.communityChat(communityId);
    if (known !== null) {
      const found = await this.repository.findConversation(known.conversationId);
      if (found !== null) return found;
    }
    return this.repository.materializeCommunityChat({
      id: this.ids.next<'Conversation'>(),
      communityId,
      at: this.clock.now(),
    });
  }
}

const UNAVAILABLE: Failure = failure(
  'unavailable',
  'unavailable',
  'A service this request needs is briefly unavailable. Try again shortly.',
);

/**
 * One refusal → one per-community outcome, for both the batch authorization and
 * a send. The two distinct precondition cases are told apart by code (a locked
 * community vs. a chat over its serving capacity); everything else by kind.
 */
function classify(error: Failure): { status: PublicationStatus; retryable: boolean } {
  switch (error.code) {
    case 'communities.community_locked':
      return { status: 'locked', retryable: false };
    case 'messaging.community_chat_over_capacity':
      return { status: 'over_capacity', retryable: false };
    default:
      break;
  }
  switch (error.kind) {
    case 'not_found':
      return { status: 'not_found', retryable: false };
    case 'forbidden':
      return { status: 'forbidden', retryable: false };
    case 'rate_limited':
      return { status: 'rate_limited', retryable: true };
    case 'unavailable':
      return { status: 'unavailable', retryable: true };
    default:
      return { status: 'failed', retryable: false };
  }
}

/** Files' refusals, restated in messaging's words at the request level. */
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
        'That kind of file cannot be published as this message type.',
        cause.details,
      );
    default:
      return failure(
        'validation',
        'messaging.attachment_not_found',
        'The attachment does not exist.',
      );
  }
}

/**
 * The per-community idempotency key: a stable, bounded digest of the batch id
 * and the community id. Deterministic, so retrying a batch reuses the key and
 * the append returns the original message instead of posting a second; bounded,
 * so it never exceeds the clientMessageId column whatever the inputs' length.
 */
function batchKey(clientBatchId: string, communityId: string): string {
  return createHash('sha256')
    .update(`${clientBatchId}\u0000${communityId}`)
    .digest('hex')
    .slice(0, 32);
}
