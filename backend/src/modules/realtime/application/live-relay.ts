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
import {
  COMMUNITY_MEMBERSHIP,
  type CommunityMembership,
} from '../../communities/contracts/membership';
import {
  LIVE_AUDIENCE,
  LiveEvents,
  MAX_AUDIENCE_PROBE,
  MODERATOR_FRAME_COALESCE_MS,
  type LiveAudience,
  type LiveMediaReset,
  type LiveParticipantRemoved,
  type LiveSessionEnded,
  type LiveSessionStarted,
} from '../../live/contracts';
import { ConnectionManager } from './connection-manager';
import {
  liveMediaResetFrame,
  liveParticipantRemovedFrame,
  liveSessionChangedFrame,
  liveSessionEndedFrame,
  liveSessionStartedFrame,
  type LiveSessionEndReason,
} from './envelopes';
import { onlineAudience } from './online-audience';

/** The facts that change a session's hands, floor or screen: each a `live.session.changed`. */
const CHANGES: readonly string[] = [
  LiveEvents.speakerRequested,
  LiveEvents.speakerGranted,
  LiveEvents.speakerDeclined,
  LiveEvents.speakerRevoked,
  LiveEvents.speakerWithdrawn,
  LiveEvents.speakerExpired,
  LiveEvents.screenShareStarted,
  LiveEvents.screenShareStopped,
];

const END_REASONS: readonly LiveSessionEndReason[] = ['moderator', 'idle', 'community_closed'];

/** What a `live.session.changed` says: where, and as of which version. */
interface SessionChange {
  readonly occurredAt: Date;
  readonly communityId: string;
  readonly sessionId: string;
  readonly stateVersion: number;
}

/**
 * A session's moderators' window: the change they will hear of next, and the
 * timer that will tell them. While the window's frame is being delivered, the
 * timer is gone and `change` gathers what comes meanwhile, for the next one.
 */
interface ModeratorWindow {
  /** The latest change not yet told; null when none has come since the last frame left. */
  change: SessionChange | null;
  /** Armed while the window is open; null while its frame is on its way. */
  timer: NodeJS.Timeout | null;
}

/**
 * Live's facts, delivered to the people connected here whom they concern —
 * as hints (live.md §16; communities-live-attendance.md §16). A frame names
 * a community, a session, a reason code or a version and nothing else; the
 * client re-reads the session over HTTP, which decides everything, so a
 * frame grants nothing and a lost one costs nothing but a moment.
 *
 *   live.session.started   the community's ACTIVE members connected here
 *   live.session.ended     (COMMUNITY_MEMBERSHIP.members, through
 *                          `onlineAudience`), then only those of them
 *                          LIVE_AUDIENCE.participantsAmong accepts — asked in
 *                          chunks of MAX_AUDIENCE_PROBE, ⌈M/1000⌉ calls for
 *                          the M members found online
 *   every hand, floor and  `live.session.changed` to the person it concerns
 *   screen-share fact      (the payload's `userId`), at once, while
 *                          participantsAmong still accepts them — a removed
 *                          member is told nothing more; and to the session's
 *                          moderators connected here (LIVE_AUDIENCE.moderators),
 *                          at most once per MODERATOR_FRAME_COALESCE_MS per
 *                          session, carrying the latest version. Listeners
 *                          hear nothing of it: LiveKit tells the room what the
 *                          room needs
 *   live.session.media_reset to the session's current participants, as a start
 *                          or an end is — they re-join the new room generation
 *                          (Q64, ADR 0026)
 *   live.participant.removed to the removed person alone, directly — the one
 *                          exception to "a removed member is told nothing",
 *                          because the frame's whole point is that they are out
 *                          of the room; the reason is audited, never framed
 *                          (Q64, ADR 0026)
 *
 * Every audience is resolved at delivery time from the owners' contracts —
 * Communities' members, Live's audience — never from the event alone, from a
 * client, or from anything kept here. The moderators' frame is coalesced by
 * a transient trailing timer per session: the first change arms it, later
 * ones only raise the version it will carry, and when it fires the
 * moderators are asked then and each gets one frame. The next window opens
 * only once that frame has left, so two frames to a session's moderators are
 * never closer than the interval, however slowly they are listed. Nothing
 * else is held, and nothing at all when no one is connected here: no timer,
 * no call — nor once the module is destroyed.
 *
 * Delivery is detached from the publisher and serialized per session (the
 * event's `aggregateId`), as the other relays do it: one session's frames
 * leave in the order its facts were published, the moderators' included, and
 * a Live request never waits for its audience. A malformed payload is logged
 * and ignored; a failing dependency costs that frame and is logged by its
 * class name; nothing is thrown back into the bus.
 */
@Injectable()
export class LiveRealtimeRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveRealtimeRelay.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  /** The tail of each session's delivery chain. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Per session with a change its moderators have yet to hear of: its window. */
  private readonly windows = new Map<string, ModeratorWindow>();
  /** Destroyed: a delivery still on its way arms nothing more. */
  private closed = false;

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(COMMUNITY_MEMBERSHIP) private readonly membership: CommunityMembership,
    @Inject(LIVE_AUDIENCE) private readonly audience: LiveAudience,
    private readonly connections: ConnectionManager,
  ) {}

  onModuleInit(): void {
    for (const name of Object.values(LiveEvents)) {
      this.unsubscribes.push(this.subscriber.subscribe(name, (event) => this.schedule(event)));
    }
  }

  onModuleDestroy(): void {
    this.closed = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    for (const { timer } of this.windows.values()) if (timer !== null) clearTimeout(timer);
    this.windows.clear();
  }

  /** Queues delivery behind the session's earlier events, and returns at once. */
  schedule(event: DomainEvent): void {
    // Nobody is connected to this instance: nothing to deliver, nothing to ask.
    if (this.connections.count() === 0) return;
    this.enqueue(event.aggregateId, event.name, () => this.relay(event));
  }

  /** Resolves once everything scheduled so far has been delivered — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /**
   * Delivers one event now; a change also arms (or raises) the moderators'
   * coalesced frame. Awaitable, for tests.
   */
  async relay(event: DomainEvent): Promise<void> {
    if (event.name === LiveEvents.sessionStarted) {
      const payload = startedPayload(event);
      if (payload === null) return this.malformed(event);
      return this.toParticipants(
        payload.communityId,
        payload.sessionId,
        liveSessionStartedFrame({
          occurredAt: event.occurredAt,
          communityId: payload.communityId,
          sessionId: payload.sessionId,
        }),
      );
    }
    if (event.name === LiveEvents.sessionEnded) {
      const payload = endedPayload(event);
      if (payload === null) return this.malformed(event);
      return this.toParticipants(
        payload.communityId,
        payload.sessionId,
        liveSessionEndedFrame({
          occurredAt: event.occurredAt,
          communityId: payload.communityId,
          sessionId: payload.sessionId,
          reason: payload.reason,
        }),
      );
    }
    if (event.name === LiveEvents.mediaReset) {
      const payload = mediaResetPayload(event);
      if (payload === null) return this.malformed(event);
      return this.toParticipants(
        payload.communityId,
        payload.sessionId,
        liveMediaResetFrame({
          occurredAt: event.occurredAt,
          communityId: payload.communityId,
          sessionId: payload.sessionId,
          toEpoch: payload.toEpoch,
        }),
      );
    }
    if (event.name === LiveEvents.participantRemoved) {
      const payload = removedPayload(event);
      if (payload === null) return this.malformed(event);
      return this.toRemoved(payload, event.occurredAt);
    }
    if (CHANGES.includes(event.name)) {
      const payload = changePayload(event);
      if (payload === null) return this.malformed(event);
      // Armed first: the moderators hear of this change even if telling the
      // person it concerns fails.
      this.coalesce(payload.change);
      return this.toConcerned(payload.change, payload.userId);
    }
  }

  /**
   * A start or an end, to the community's ACTIVE members connected here
   * whom Live accepts as participants of the session — one frame each.
   */
  private async toParticipants(
    communityId: string,
    sessionId: string,
    frame: string,
  ): Promise<void> {
    const members = await onlineAudience(this.connections, (page) =>
      this.membership.members(communityId, {
        onlyUserIds: page.onlyUserIds,
        cursor: page.cursor,
        limit: page.limit,
      }),
    );
    const recipients: string[] = [];
    for (let from = 0; from < members.length; from += MAX_AUDIENCE_PROBE) {
      const chunk = members.slice(from, from + MAX_AUDIENCE_PROBE);
      recipients.push(...(await this.audience.participantsAmong(sessionId, chunk)));
    }
    if (recipients.length === 0) return;
    this.connections.sendToUsers(recipients, frame);
  }

  /** The change, at once, to its person, while connected here and still a participant. */
  private async toConcerned(change: SessionChange, userId: string): Promise<void> {
    if (!this.connections.isOnline(userId)) return;
    const [still] = await this.audience.participantsAmong(change.sessionId, [userId]);
    if (still !== userId) return;
    this.connections.sendToUser(userId, liveSessionChangedFrame(change));
  }

  /**
   * The removed person, told they are out — directly, to them alone, without
   * the `participantsAmong` gate every other fact passes (Q64, ADR 0026). That
   * gate exists to stop telling someone no longer in the session; here the fact
   * IS that they are out of it, so the gate would suppress the very frame it
   * should carry. It names the session and community only — never the reason,
   * which is audited — and the person may re-join at once over HTTP.
   */
  private toRemoved(payload: LiveParticipantRemoved['payload'], occurredAt: Date): void {
    if (!this.connections.isOnline(payload.userId)) return;
    this.connections.sendToUser(
      payload.userId,
      liveParticipantRemovedFrame({
        occurredAt,
        communityId: payload.communityId,
        sessionId: payload.sessionId,
      }),
    );
  }

  /**
   * Opens the session's window with a trailing timer, or raises the version
   * the open one will carry. At most one moderators' frame per
   * MODERATOR_FRAME_COALESCE_MS per session, whatever the rate of changes.
   */
  private coalesce(change: SessionChange): void {
    if (this.closed) return;
    const open = this.windows.get(change.sessionId);
    if (open === undefined) return this.arm(change);
    if (open.change === null || change.stateVersion > open.change.stateVersion) {
      open.change = change;
    }
  }

  private arm(change: SessionChange): void {
    const timer = setTimeout(() => this.fire(change.sessionId), MODERATOR_FRAME_COALESCE_MS);
    // A hint's timer never keeps the process alive.
    timer.unref();
    this.windows.set(change.sessionId, { change, timer });
  }

  /**
   * The window closed: the moderators' frame joins the session's chain and
   * the timer is dropped. Once the frame has left, a change that came
   * meanwhile opens the next window.
   */
  private fire(sessionId: string): void {
    const closing = this.windows.get(sessionId);
    if (closing === undefined || closing.change === null) return;
    const change = closing.change;
    if (this.connections.count() === 0) {
      this.windows.delete(sessionId);
      return;
    }
    closing.change = null;
    closing.timer = null;
    this.enqueue(sessionId, 'live.session.changed', async () => {
      try {
        await this.toModerators(change);
      } finally {
        this.reopen(sessionId);
      }
    });
  }

  /** The moderators' frame has left (or failed): the next window, if anything came meanwhile. */
  private reopen(sessionId: string): void {
    const delivered = this.windows.get(sessionId);
    if (delivered === undefined) return;
    this.windows.delete(sessionId);
    if (delivered.change !== null) this.coalesce(delivered.change);
  }

  /** The latest change, once, to each of the session's moderators connected here — asked now. */
  private async toModerators(change: SessionChange): Promise<void> {
    if (this.connections.count() === 0) return;
    const recipients: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.audience.moderators(change.sessionId, {
        cursor,
        limit: MAX_AUDIENCE_PROBE,
      });
      for (const userId of page.userIds) {
        if (this.connections.isOnline(userId)) recipients.push(userId);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (recipients.length === 0) return;
    this.connections.sendToUsers(recipients, liveSessionChangedFrame(change));
  }

  /** Runs `deliver` behind the session's earlier deliveries; a failure is logged, never thrown. */
  private enqueue(key: string, name: string, deliver: () => Promise<void>): void {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(deliver).catch((error: unknown) =>
      this.logger.error(
        {
          event: 'realtime.live.delivery_failed',
          name,
          sessionId: key,
          err: { name: error instanceof Error ? error.name : typeof error },
        },
        'realtime delivery failed',
      ),
    );
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  private malformed(event: DomainEvent): void {
    // The name only: a payload that is not what Live publishes may carry anything.
    this.logger.warn(
      { event: 'realtime.live.malformed', name: event.name },
      'ignoring a malformed live event',
    );
  }
}

// Events cross a module boundary: their shape is checked, not assumed — and a
// payload about another session than the one its event is ordered under is
// not delivered out of that order.

type Fields = Readonly<Record<string, unknown>>;

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isVersion = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The payload, when it names a community and the session its event is ordered under. */
function fieldsOf(event: DomainEvent): Fields | null {
  const payload = event.payload as Fields | null;
  if (payload === null || typeof payload !== 'object') return null;
  return isId(payload.sessionId) &&
    payload.sessionId === event.aggregateId &&
    isId(payload.communityId)
    ? payload
    : null;
}

function startedPayload(event: DomainEvent): LiveSessionStarted['payload'] | null {
  const p = fieldsOf(event);
  if (p === null) return null;
  return p as unknown as LiveSessionStarted['payload'];
}

function endedPayload(event: DomainEvent): LiveSessionEnded['payload'] | null {
  const p = fieldsOf(event);
  if (p === null || !END_REASONS.includes(p.reason as LiveSessionEndReason)) return null;
  return p as unknown as LiveSessionEnded['payload'];
}

/** What a hand, floor or screen fact changed, and whose — every one names both. */
function changePayload(
  event: DomainEvent,
): { readonly change: SessionChange; readonly userId: string } | null {
  const p = fieldsOf(event);
  if (p === null || !isId(p.userId) || !isVersion(p.stateVersion)) return null;
  return {
    change: {
      occurredAt: event.occurredAt,
      communityId: p.communityId as string,
      sessionId: p.sessionId as string,
      stateVersion: p.stateVersion,
    },
    userId: p.userId,
  };
}

/** A removal names the person removed; the reason and remover ride the audit, not the frame. */
function removedPayload(event: DomainEvent): LiveParticipantRemoved['payload'] | null {
  const p = fieldsOf(event);
  if (p === null || !isId(p.userId)) return null;
  return p as unknown as LiveParticipantRemoved['payload'];
}

/** A reset names the generation it moved to, which the frame's id carries. */
function mediaResetPayload(event: DomainEvent): LiveMediaReset['payload'] | null {
  const p = fieldsOf(event);
  if (p === null || !isVersion(p.toEpoch)) return null;
  return p as unknown as LiveMediaReset['payload'];
}
