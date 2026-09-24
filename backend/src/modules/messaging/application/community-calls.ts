import type { Logger } from '@nestjs/common';

import { err, ok, type Result } from '../../../shared';
import type { MemberState } from '../../communities/contracts/membership';
import type { CommunityMemberState } from '../domain/community-chat';
import { COMMUNITIES_UNAVAILABLE } from './community-chat-settings';

/**
 * Communities' member state in messaging's own shape: the messaging domain
 * never imports Communities, so the application maps one onto the other.
 */
export function memberStateOf(state: MemberState): CommunityMemberState {
  return {
    userId: state.userId,
    membershipId: state.membershipId,
    active: state.active,
    joinedAt: state.joinedAt,
    version: state.version,
  };
}

/**
 * A call to Communities made while answering a person. A rejection — a store
 * failure, a timeout — becomes 503 `unavailable`: the request fails closed
 * and is never answered from roles alone. Logged by class only; a message
 * could echo a query.
 */
export async function askCommunities<T>(
  logger: Pick<Logger, 'error'>,
  call: () => Promise<T>,
): Promise<Result<T>> {
  try {
    return ok(await call());
  } catch (error) {
    logger.error(
      { err: { name: error instanceof Error ? error.name : typeof error } },
      'Communities could not answer; failing closed',
    );
    return err(COMMUNITIES_UNAVAILABLE);
  }
}
