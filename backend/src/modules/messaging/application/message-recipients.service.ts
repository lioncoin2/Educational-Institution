import { Inject, Injectable } from '@nestjs/common';

import {
  ACCOUNT_DIRECTORY,
  type AccountDirectory,
} from '../../identity/contracts/account-directory';
import { Permissions } from '../../identity/contracts/permissions';
import {
  MAX_RECIPIENT_PAGE,
  type MessageRecipients,
  type RecipientPage,
} from '../contracts/message-recipients';
import type { ConversationId } from '../domain/conversation';
import { MESSAGING_READ_MODEL, type MessagingReadModel } from '../domain/ports';
import { decodeMemberCursor, encodeMemberCursor } from './cursors';

/**
 * Current members of a conversation, for delivery modules. Ids only: what a
 * notification says, and to whom it may show a preview, is decided where the
 * message can be read — here, through the use cases — not in the fan-out.
 *
 * No principal: this answers trusted in-process code (the event subscribers),
 * never a request, and it discloses nothing but membership.
 *
 * `readersOnly` narrows a page to the members who may read the conversation
 * now — asked of identity through the account directory, the same way
 * messaging decides who may be added as a reader. A page may therefore hold
 * fewer ids than its limit; the cursor still continues after the last member
 * examined, so nobody is skipped or seen twice.
 */
@Injectable()
export class MessageRecipientsService implements MessageRecipients {
  constructor(
    @Inject(MESSAGING_READ_MODEL) private readonly readModel: MessagingReadModel,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
  ) {}

  async list(
    conversationId: string,
    options: {
      readonly excludeUserId?: string;
      readonly visibleSequence?: number;
      readonly readersOnly?: boolean;
      readonly onlyUserIds?: readonly string[];
      readonly cursor?: string | null;
      readonly limit: number;
    },
  ): Promise<RecipientPage> {
    const after = decodeMemberCursor(options.cursor);
    if (!after.ok) throw new RangeError('Invalid recipient cursor.');
    if (options.onlyUserIds !== undefined && options.onlyUserIds.length > MAX_RECIPIENT_PAGE) {
      throw new RangeError(`At most ${MAX_RECIPIENT_PAGE} users may be named at once.`);
    }
    const page = await this.readModel.listMemberIds(conversationId as ConversationId, {
      limit: Math.max(1, Math.min(options.limit, MAX_RECIPIENT_PAGE)),
      afterUserId: after.value,
      excludeUserId: options.excludeUserId,
      visibleSequence: options.visibleSequence,
      onlyUserIds: options.onlyUserIds,
    });
    return {
      userIds: options.readersOnly === true ? await this.readers(page.userIds) : page.userIds,
      nextCursor: page.next === null ? null : encodeMemberCursor(page.next),
    };
  }

  private async readers(userIds: readonly string[]): Promise<readonly string[]> {
    if (userIds.length === 0) return userIds;
    const allowed = await this.directory.withPermission(userIds, Permissions.messaging.read);
    return userIds.filter((userId) => allowed.has(userId));
  }
}
