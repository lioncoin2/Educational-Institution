import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import {
  EVENT_SUBSCRIBER,
  type DomainEvent,
  type EventSubscriber,
  type Unsubscribe,
} from '../../../shared';
import { CommunityEvents } from '../../communities/contracts/events';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import { LiveReconciler, type SessionCheckReport } from './live-reconciler';

/** The Communities facts that can change who may stay in, or moderate, a running session. */
export const PROTECTED_BY = [
  CommunityEvents.memberRemoved,
  CommunityEvents.capabilityRevoked,
  CommunityEvents.ownershipTransferred,
  CommunityEvents.communityLocked,
  CommunityEvents.communityUnlocked,
] as const;

/** What one Communities fact asks of the community's live session. */
type Check =
  | { readonly communityId: string; readonly kind: 'identities'; readonly userIds: string[] }
  | { readonly communityId: string; readonly kind: 'session' };

/**
 * `ProtectLiveSessions` (live.md §11.6; audit D17) — accelerators, not
 * correctness. A Communities fact that can change who may stay in a running
 * session, or who moderates it, has the reconciler look at once, rather than
 * at its next sweep:
 *
 *   member.removed, capability.revoked   the per-identity step for the user
 *   ownership.transferred                the per-identity step for the old
 *                                        owner (who loses the owner's implicit
 *                                        moderation) and the new one
 *   community.locked, .unlocked          the per-session step: Communities'
 *                                        lifecycle, then everyone connected
 *                                        and every holder of the floor or the
 *                                        presenter slot
 *
 * An event is a hint, never a grant: it names who and where to look, and
 * nothing more is read from it. Every decision is the reconciler's, from
 * Communities' answers now — so a LOCKED community's members stay (a lock
 * stops joining, not a running session), and a lost, late, repeated or forged
 * event costs nothing but time: the participant sweep reaches the same state
 * within one period (ADR 0021 decision 4).
 *
 * Handling is detached from the publisher (the in-process bus awaits its
 * subscribers; a Communities request must not wait on Live's provider calls)
 * and chained per community id, so one community's facts are looked at in the
 * order published. The reconciler serializes each session's steps with its own
 * ticks. A malformed payload is logged and ignored; nothing is ever thrown back
 * into the bus.
 */
@Injectable()
export class ProtectLiveSessions implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProtectLiveSessions.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  /** The tail of each community's chain. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    private readonly reconciler: LiveReconciler,
  ) {}

  onModuleInit(): void {
    for (const name of PROTECTED_BY) {
      this.unsubscribes.push(this.subscriber.subscribe(name, (event) => this.schedule(event)));
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    await this.idle();
  }

  /** Queues the check behind the community's earlier ones, and returns at once. Never throws. */
  schedule(event: DomainEvent): void {
    const check = checkFor(event);
    if (check === null) {
      // The name only: a payload that is not what Communities publishes may
      // carry anything.
      this.logger.warn(
        { event: 'live.protect.malformed', name: event.name },
        'ignoring a malformed Communities event',
      );
      return;
    }
    const key = check.communityId;
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.protect(check))
      .then(
        () => undefined,
        (error: unknown) =>
          this.logger.error(
            {
              event: 'live.protect.failed',
              name: event.name,
              communityId: key,
              err: { name: error instanceof Error ? error.name : typeof error },
            },
            'could not look at a live session after a Communities fact; the sweep will',
          ),
      );
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** Resolves once everything scheduled so far has been handled — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** The community's live session, if any, checked now: its report, or null when none is live. */
  private async protect(check: Check): Promise<SessionCheckReport | null> {
    const session = await this.sessions.findLiveByCommunity(check.communityId);
    if (session === null) return null;
    return check.kind === 'session'
      ? this.reconciler.checkSession(session.id)
      : this.reconciler.checkIdentities(session.id, check.userIds);
  }
}

// Events cross a module boundary: their shape is checked, not assumed — and a
// payload about another community than the one its event is ordered under is
// not acted on.

type Fields = Readonly<Record<string, unknown>>;

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function checkFor(event: DomainEvent): Check | null {
  const payload = event.payload as Fields | null;
  if (payload === null || typeof payload !== 'object') return null;
  const communityId = payload.communityId;
  if (!isId(communityId) || communityId !== event.aggregateId) return null;
  switch (event.name) {
    case CommunityEvents.memberRemoved:
    case CommunityEvents.capabilityRevoked:
      return isId(payload.userId)
        ? { communityId, kind: 'identities', userIds: [payload.userId] }
        : null;
    case CommunityEvents.ownershipTransferred:
      return isId(payload.fromUserId) && isId(payload.toUserId)
        ? { communityId, kind: 'identities', userIds: [payload.fromUserId, payload.toUserId] }
        : null;
    case CommunityEvents.communityLocked:
    case CommunityEvents.communityUnlocked:
      return { communityId, kind: 'session' };
    default:
      return null;
  }
}
