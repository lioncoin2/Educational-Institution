import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, err, failure, ok, type Clock, type Principal, type Result } from '../../../shared';
import { CONVERSATION_MUTE_REPOSITORY, type ConversationMuteRepository } from '../domain/ports';
import { toMutedConversationView, type MutedConversationView } from './views';

/** Bounds a conversation id the same way the mutes table does. */
function validConversationId(value: string): boolean {
  return value.length >= 1 && value.length <= 128;
}

function conversationIdError(conversationId: string): Result<never> {
  return err(
    failure(
      'validation',
      'notifications.conversation_id_invalid',
      'A conversation id is 1 to 128 characters.',
      { conversationId },
    ),
  );
}

/**
 * Per-conversation mute — a person's own choice to hold PUSH for one
 * conversation. Scoped to the principal; there is no way to mute on anyone
 * else's behalf, or to read anyone else's mutes.
 *
 * The conversation id is opaque: it is the id the client already holds (from a
 * notification's target or the conversation list), stored as given. Muting
 * removes no membership, revokes no capability, changes no access, and disables
 * no category — it suppresses push for that one conversation, and nothing more.
 * The in-app record is still stored and realtime is untouched.
 */
@Injectable()
export class MuteConversationUseCase {
  constructor(
    @Inject(CONVERSATION_MUTE_REPOSITORY) private readonly mutes: ConversationMuteRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly principal: Principal;
    readonly conversationId: string;
  }): Promise<Result<{ conversationId: string; muted: true }>> {
    if (!validConversationId(input.conversationId)) {
      return conversationIdError(input.conversationId);
    }
    await this.mutes.mute(input.principal.userId, input.conversationId, this.clock.now());
    return ok({ conversationId: input.conversationId, muted: true });
  }
}

/** Unmutes one conversation. Restores push for it; everything else is unchanged. */
@Injectable()
export class UnmuteConversationUseCase {
  constructor(
    @Inject(CONVERSATION_MUTE_REPOSITORY) private readonly mutes: ConversationMuteRepository,
  ) {}

  async execute(input: {
    readonly principal: Principal;
    readonly conversationId: string;
  }): Promise<Result<{ conversationId: string; muted: false }>> {
    if (!validConversationId(input.conversationId)) {
      return conversationIdError(input.conversationId);
    }
    await this.mutes.unmute(input.principal.userId, input.conversationId);
    return ok({ conversationId: input.conversationId, muted: false });
  }
}

/** The caller's own muted conversations, newest first. */
@Injectable()
export class ListMutedConversationsUseCase {
  constructor(
    @Inject(CONVERSATION_MUTE_REPOSITORY) private readonly mutes: ConversationMuteRepository,
  ) {}

  async execute(input: {
    readonly principal: Principal;
  }): Promise<Result<MutedConversationView[]>> {
    const muted = await this.mutes.listMuted(input.principal.userId);
    return ok(muted.map(toMutedConversationView));
  }
}
