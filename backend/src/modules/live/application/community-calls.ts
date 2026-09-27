import type { Logger } from '@nestjs/common';

import { err, ok, type Result } from '../../../shared';
import { LiveRefusals } from './live-settings';

/**
 * A call to Communities — or to identity's account directory behind it —
 * made while answering a person (audit D14). A rejection, a store failure or
 * a timeout, becomes 503 `unavailable`: the request fails closed and is never
 * answered from roles alone. Logged by class only; a message could echo a
 * query.
 *
 * Live's own, never Messaging's: Live must not depend on Messaging.
 */
export async function askCommunities<T>(
  logger: Pick<Logger, 'error'>,
  call: () => Promise<T>,
): Promise<Result<T>> {
  try {
    return ok(await call());
  } catch (error) {
    logger.error(
      {
        event: 'live.communities.unavailable',
        err: { name: error instanceof Error ? error.name : typeof error },
      },
      'Communities could not answer; failing closed',
    );
    return err(LiveRefusals.unavailable);
  }
}
