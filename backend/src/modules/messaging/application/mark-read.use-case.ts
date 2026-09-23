import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  EVENT_PUBLISHER,
  err,
  failure,
  ok,
  type CallMetadata,
  type Clock,
  type EventPublisher,
  type Principal,
  type Result,
} from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { messageRead } from '../domain/events';
import { MESSAGING_REPOSITORY, type MessagingRepository } from '../domain/ports';
import { CONVERSATION_NOT_FOUND, ConversationAccess } from './conversation-access';

/**
 * "I have read up to here." The watermark only moves forward and never past
 * the last message, whatever the client sends — so stale devices, reordered
 * requests and hostile values all leave it correct.
 */
@Injectable()
export class MarkReadUseCase {
  constructor(
    private readonly access: ConversationAccess,
    @Inject(MESSAGING_REPOSITORY) private readonly repository: MessagingRepository,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly conversationId: string;
    readonly sequence: number;
    readonly meta: CallMetadata;
  }): Promise<Result<{ lastReadSequence: number }>> {
    if (!Number.isSafeInteger(command.sequence) || command.sequence < 0) {
      return err(
        failure('validation', 'messaging.sequence_invalid', 'That sequence is not valid.'),
      );
    }
    const membership = await this.access.member(
      command.principal,
      command.conversationId,
      Permissions.messaging.read,
    );
    if (!membership.ok) return membership;

    const outcome = await this.repository.markRead(
      membership.value.conversation.id,
      command.principal.userId,
      command.sequence,
    );
    switch (outcome.kind) {
      case 'not_participant':
        return err(CONVERSATION_NOT_FOUND);
      case 'unchanged':
        return ok({ lastReadSequence: outcome.lastReadSequence });
      case 'advanced':
        await this.events.publish([
          messageRead(
            command.conversationId,
            command.principal.userId,
            outcome.lastReadSequence,
            this.clock.now(),
            command.meta.correlationId,
          ),
        ]);
        return ok({ lastReadSequence: outcome.lastReadSequence });
    }
  }
}
