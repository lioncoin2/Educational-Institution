import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  RATE_LIMITER,
  err,
  ok,
  type CallMetadata,
  type Clock,
  type IdGenerator,
  type Principal,
  type RateLimiter,
  type Result,
} from '../../../shared';
import {
  ACCOUNT_DIRECTORY,
  AUTHORIZATION_SERVICE,
  Permissions,
  type AccountDirectory,
  type AuthorizationService,
} from '../../identity/contracts';
import type { LiveChat, LiveChatMessageView } from '../contracts/live-chat';
import { liveChatLockChanged, liveChatPosted } from '../domain/events';
import {
  liveChatBody,
  validClientMessageId,
  type LiveChatMessage,
  type LiveChatState,
} from '../domain/live-chat';
import { LIVE_CHAT_PAGE_DEFAULT, LIVE_CHAT_PAGE_MAX, LiveRateLimits } from '../domain/live-limits';
import { isLive } from '../domain/live-session';
import {
  LIVE_CHAT_REPOSITORY,
  LIVE_SESSION_REPOSITORY,
  type LiveChatRepository,
  type LiveSessionRepository,
} from '../domain/ports';
import { LiveAccess, permitOf, takesPart } from './live-access';
import { LiveJournal } from './live-journal';
import {
  LIVE_AUDIT_RESOURCE,
  LiveRefusals,
  isLiveId,
  sessionUserKey,
  tooMany,
} from './live-settings';

/** What a participant sees of a session's chat: a page, and where the chat stands for them. */
export interface LiveChatPage {
  readonly items: readonly LiveChatMessageView[];
  /** Pass back as `before` for older messages; null at the beginning of the chat. */
  readonly nextCursor: string | null;
  readonly locked: boolean;
  readonly lockVersion: number;
  /** Whether the caller may post now: the session live, and the chat open or theirs to moderate. */
  readonly canPost: boolean;
  /** Whether the caller may lock and unlock it. */
  readonly canModerate: boolean;
}

export interface LiveChatPostResult {
  readonly created: boolean;
  readonly message: LiveChatMessageView;
}

export interface LiveChatLockResult {
  readonly changed: boolean;
  readonly locked: boolean;
  readonly lockVersion: number;
}

/** Messages with their senders' names, one directory call for the page. */
async function viewsOf(
  directory: AccountDirectory,
  messages: readonly LiveChatMessage[],
): Promise<LiveChatMessageView[]> {
  if (messages.length === 0) return [];
  const accounts = await directory.describe([...new Set(messages.map((m) => m.senderId))]);
  const names = new Map(accounts.map((account) => [account.userId, account.displayName]));
  return messages.map((message) => ({
    id: message.id,
    sessionId: message.sessionId,
    senderId: message.senderId,
    senderDisplayName: names.get(message.senderId) ?? '',
    body: message.body,
    createdAt: message.createdAt,
    position: message.position,
  }));
}

/**
 * A session's own chat, read (owner decision F, ADR 0047): everyone who may
 * see the session reads it — its participants and moderators, and a member
 * the lifecycle keeps from joining — in pages, newest first; an ended
 * session's chat stays readable. Anyone else hears the 404 an unknown session
 * is. The page says whether the chat is locked and what the caller may do,
 * as the server decides it now — the client's late join and reconnect read.
 */
@Injectable()
export class ListLiveChatUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(LIVE_CHAT_REPOSITORY) private readonly chat: LiveChatRepository,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly before?: string;
    readonly limit?: number;
  }): Promise<Result<LiveChatPage>> {
    const { principal } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.join);
    if (!allowed.ok) return allowed;
    if (!isLiveId(command.sessionId)) return err(LiveRefusals.sessionNotFound);
    const before = positionOf(command.before);
    if (before === undefined) return err(LiveRefusals.cursorInvalid);

    const session = await this.sessions.findById(command.sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const participation = await this.access.viewer(
      principal,
      session,
      LiveRefusals.sessionNotFound,
    );
    if (!participation.ok) return participation;

    const limit = chatPageLimit(command.limit);
    const [messages, state] = await Promise.all([
      this.chat.page(session.id, { beforePosition: before, limit: limit + 1 }),
      this.chat.state(session.id),
    ]);
    const page = messages.slice(0, limit);
    const last = page[page.length - 1];
    const current: LiveChatState = state ?? { locked: false, lockVersion: 0 };
    const moderator = participation.value.moderator !== null;
    return ok({
      items: await viewsOf(this.directory, page),
      nextCursor: messages.length > limit && last !== undefined ? String(last.position) : null,
      locked: current.locked,
      lockVersion: current.lockVersion,
      canPost: isLive(session) && takesPart(participation.value) && (moderator || !current.locked),
      canModerate: moderator && isLive(session),
    });
  }
}

/**
 * Posting to a session's chat (decision F): every participant posts by
 * default; while a moderator has locked it, only moderators do — decided by
 * the store AT THE WRITE, so a post racing a lock never lands after it.
 *
 *   1. identity's `live.join` (the route's gate, asked again); a malformed id
 *      is the 404 an unknown one is; the caller's limit in this session;
 *   2. the client's key and the text, bounded (422);
 *   3. the session (404), and the caller a participant of it now
 *      (LiveAccess: 404 like an unknown session, 412 for the lifecycle, 503);
 *   4. live, else 412;
 *   5. the write: `posted` 201, a retry of the same post 200 with the stored
 *      message, a reused key 409, a lock 403 `live.chat_locked`.
 * Announced as `live.chat.posted` (ids only); not audited — a person's own act.
 */
@Injectable()
export class PostLiveChatUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(LIVE_CHAT_REPOSITORY) private readonly chat: LiveChatRepository,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly journal: LiveJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly clientMessageId: string;
    readonly body: string;
    readonly meta: CallMetadata;
  }): Promise<Result<LiveChatPostResult>> {
    const { principal, sessionId } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.join);
    if (!allowed.ok) return allowed;
    if (!isLiveId(sessionId)) return err(LiveRefusals.sessionNotFound);
    const throttle = await this.limiter.consume(
      sessionUserKey(sessionId, principal.userId),
      LiveRateLimits.chatPostsPerSessionUser,
    );
    if (!throttle.allowed) {
      return err(tooMany('live.too_many_chat_messages', throttle.retryAfterSeconds));
    }
    const key = validClientMessageId(command.clientMessageId);
    if (!key.ok) return key;
    const body = liveChatBody(command.body);
    if (!body.ok) return body;

    const session = await this.sessions.findById(sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const participation = await this.access.participant(
      principal,
      session,
      LiveRefusals.sessionNotFound,
    );
    if (!participation.ok) return participation;
    if (!isLive(session)) return err(LiveRefusals.sessionNotLive);

    const outcome = await this.chat.post(
      {
        id: this.ids.next<'LiveChatMessage'>(),
        sessionId: session.id,
        senderId: principal.userId,
        clientMessageId: key.value,
        body: body.value,
        createdAt: this.clock.now(),
      },
      { moderator: participation.value.moderator !== null },
    );
    switch (outcome.kind) {
      case 'session_not_live':
        return err(LiveRefusals.sessionNotLive);
      case 'locked':
        return err(LiveRefusals.chatLocked);
      case 'key_reused':
        return err(LiveRefusals.chatKeyReused);
      case 'duplicate': {
        const [view] = await viewsOf(this.directory, [outcome.message]);
        return ok({ created: false, message: view });
      }
      case 'posted': {
        await this.journal.record(null, [
          liveChatPosted(session, outcome.message, command.meta.correlationId),
        ]);
        const [view] = await viewsOf(this.directory, [outcome.message]);
        return ok({ created: true, message: view });
      }
    }
  }
}

/**
 * A moderator locks or unlocks a session's chat (decision F): `live.moderate`
 * at the edge, and `LiveAccess.moderator` on the session's own community — a
 * participant who does not moderate is 403 `live.not_a_moderator`, anyone
 * else the 404 an unknown session is. Only while live (412). A real change
 * is audited with the permit it ran on and announced as
 * `live.chat.lock_changed`; a repeat changes, audits and announces nothing.
 */
@Injectable()
export class SetLiveChatLockUseCase {
  constructor(
    @Inject(AUTHORIZATION_SERVICE) private readonly identity: AuthorizationService,
    private readonly access: LiveAccess,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(LIVE_CHAT_REPOSITORY) private readonly chat: LiveChatRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: LiveJournal,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sessionId: string;
    readonly locked: boolean;
    readonly meta: CallMetadata;
  }): Promise<Result<LiveChatLockResult>> {
    const { principal } = command;
    const allowed = this.identity.authorize(principal, Permissions.live.moderate);
    if (!allowed.ok) return allowed;
    if (!isLiveId(command.sessionId)) return err(LiveRefusals.sessionNotFound);

    const session = await this.sessions.findById(command.sessionId);
    if (session === null) return err(LiveRefusals.sessionNotFound);
    const permit = await this.access.moderator(principal, session, LiveRefusals.sessionNotFound);
    if (!permit.ok) return permit;
    if (!isLive(session)) return err(LiveRefusals.sessionNotLive);

    const outcome = await this.chat.setLocked(session.id, command.locked);
    if (outcome.kind === 'session_not_live') return err(LiveRefusals.sessionNotLive);
    if (outcome.kind === 'changed') {
      const at = this.clock.now();
      await this.journal.record(
        {
          actorUserId: principal.userId,
          action: command.locked ? 'live.chat.locked' : 'live.chat.unlocked',
          resourceType: LIVE_AUDIT_RESOURCE,
          resourceId: session.id,
          at,
          metadata: {
            communityId: session.communityId,
            lockVersion: outcome.state.lockVersion,
            permit: permitOf(permit.value),
          },
          correlationId: command.meta.correlationId,
        },
        [
          liveChatLockChanged(
            session,
            outcome.state,
            principal.userId,
            at,
            command.meta.correlationId,
          ),
        ],
      );
    }
    return ok({
      changed: outcome.kind === 'changed',
      locked: outcome.state.locked,
      lockVersion: outcome.state.lockVersion,
    });
  }
}

/** LIVE_CHAT: a message rendered for the realtime relay, which gates its audience. */
@Injectable()
export class LiveChatReader implements LiveChat {
  constructor(
    @Inject(ACCOUNT_DIRECTORY) private readonly directory: AccountDirectory,
    @Inject(LIVE_CHAT_REPOSITORY) private readonly chat: LiveChatRepository,
  ) {}

  async forDelivery(sessionId: string, messageId: string): Promise<LiveChatMessageView | null> {
    const message = await this.chat.find(sessionId, messageId);
    if (message === null) return null;
    const [view] = await viewsOf(this.directory, [message]);
    return view ?? null;
  }
}

/** 1 to LIVE_CHAT_PAGE_MAX; anything else asked for — or nothing — is the default. */
export function chatPageLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isInteger(requested) || requested < 1) {
    return LIVE_CHAT_PAGE_DEFAULT;
  }
  return Math.min(requested, LIVE_CHAT_PAGE_MAX);
}

/** The `before` cursor: a position this API issued, or none; undefined when malformed. */
function positionOf(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return null;
  if (!/^[1-9][0-9]{0,15}$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export { LIVE_CHAT_PAGE_MAX } from '../domain/live-limits';
