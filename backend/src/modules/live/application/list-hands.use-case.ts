import { Inject, Injectable } from '@nestjs/common';

import { err, ok, type Principal, type Result } from '../../../shared';
import {
  ACCOUNT_DIRECTORY,
  AUTHORIZATION_SERVICE,
  Permissions,
  type AccountDirectory,
  type AuthorizationService,
} from '../../identity/contracts';
import { HANDS_PAGE_DEFAULT, HANDS_PAGE_MAX } from '../domain/live-limits';
import {
  LIVE_SESSION_REPOSITORY,
  SPEAKER_REQUEST_REPOSITORY,
  type LiveSessionRepository,
  type SpeakerRequestRepository,
} from '../domain/ports';
import type { QueueKey, SpeakerRequest } from '../domain/speaker-request';
import { LiveAccess } from './live-access';
import { LiveMedia } from './live-media';
import { LiveRefusals, isLiveId } from './live-settings';
import { speakerRequestView, type HandView, type HandsPage } from './views';

/** Which hands a page lists: the queue, or who holds the floor. */
export const HANDS_STATES = ['pending', 'granted'] as const;
export type HandsState = (typeof HANDS_STATES)[number];

/**
 * The page's bound, published for the transport edge: the api layer may not
 * import the domain, and its validator must accept exactly the sizes this
 * use case pages by (identity's `input-vocabulary.ts` does the same).
 */
export { HANDS_PAGE_MAX } from '../domain/live-limits';

/**
 * The moderators' view of the hands (live.md §15.1; audit D7):
 *
 *   pending   the queue, first come first served — a keyset page of 1 to
 *             HANDS_PAGE_MAX (default HANDS_PAGE_DEFAULT) with an opaque
 *             cursor, however long the queue is;
 *   granted   who holds the floor — never more than MAX_CONCURRENT_SPEAKERS
 *             — each with their connection as last observed.
 *
 * Names come from the account directory for the page's people only, never
 * an email and never anything a client sent. Moderators only: `LiveAccess`
 * answers 404, 403 or 503 like every moderation route.
 */
@Injectable()
export class ListHandsUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(SPEAKER_REQUEST_REPOSITORY) private readonly requests: SpeakerRequestRepository,
    private readonly media: LiveMedia,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly state?: HandsState;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<Result<HandsPage>> {
    const { principal } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;
    if (!isLiveId(command.sessionId)) return err(LiveRefusals.sessionNotFound);

    const session = await this.sessions.findById(command.sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const permit = await this.access.moderator(principal, session, LiveRefusals.sessionNotFound);
    if (!permit.ok) return permit;

    if (command.state === 'granted') {
      const speakers = await this.requests.granted(session.id);
      const names = await this.namesOf(speakers);
      return ok({
        items: speakers.map((request) => ({
          ...handView(request, names),
          media: this.media.observed(session.id, request.userId),
        })),
        nextCursor: null,
      });
    }

    const after = decodeHandsCursor(command.cursor);
    if (!after.ok) return after;
    const limit = handsPageLimit(command.limit);
    const pending = await this.requests.pendingPage(session.id, after.value, limit);
    const last = pending[pending.length - 1];
    // A full page may be the last: one more row, read from where it ends, says.
    const more =
      last !== undefined &&
      pending.length === limit &&
      (await this.requests.pendingPage(session.id, last, 1)).length > 0;
    const names = await this.namesOf(pending);
    return ok({
      items: pending.map((request) => handView(request, names)),
      nextCursor: more ? encodeHandsCursor(last) : null,
    });
  }

  private async namesOf(requests: readonly SpeakerRequest[]): Promise<ReadonlyMap<string, string>> {
    if (requests.length === 0) return new Map();
    const accounts = await this.directory.describe([
      ...new Set(requests.map((request) => request.userId)),
    ]);
    return new Map(accounts.map((account) => [account.userId, account.displayName]));
  }
}

function handView(request: SpeakerRequest, names: ReadonlyMap<string, string>): HandView {
  return { ...speakerRequestView(request), displayName: names.get(request.userId) ?? '' };
}

/** 1 to HANDS_PAGE_MAX; anything else asked for — or nothing — is the default. */
export function handsPageLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
    return HANDS_PAGE_DEFAULT;
  }
  return Math.min(requested, HANDS_PAGE_MAX);
}

/**
 * The queue's cursor, opaque to clients: base64url of the (requestedAt, id)
 * the next page continues after — `communities/application/cursors.ts`'s
 * pattern, with its own tag so no other list's cursor is taken for one.
 */
const CURSOR_TAG = 'h1';

export function encodeHandsCursor(key: QueueKey): string {
  return Buffer.from(JSON.stringify([CURSOR_TAG, key.requestedAt.toISOString(), key.id])).toString(
    'base64url',
  );
}

export function decodeHandsCursor(raw: string | undefined): Result<QueueKey | null> {
  if (raw === undefined) return ok(null);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed[0] === CURSOR_TAG &&
      typeof parsed[1] === 'string' &&
      typeof parsed[2] === 'string' &&
      isLiveId(parsed[2])
    ) {
      const requestedAt = new Date(parsed[1]);
      if (!Number.isNaN(requestedAt.getTime())) return ok({ requestedAt, id: parsed[2] });
    }
  } catch {
    // Falls through: whatever it was, it was not one of ours.
  }
  return err(LiveRefusals.cursorInvalid);
}
