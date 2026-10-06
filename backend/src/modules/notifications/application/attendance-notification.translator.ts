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
import { AttendanceEvents } from '../../attendance/contracts';
import {
  COMMUNITY_CAPABILITY_HOLDERS,
  MAX_HOLDER_PAGE,
  type CommunityCapabilityHolders,
} from '../../communities/contracts';
import { bodyKeyOf, titleKeyOf } from '../domain/catalog';
import type { NotificationRequest } from '../domain/notification';
import { NotificationDispatcher } from './notification-dispatcher';

/** The capability whose holders oversee attendance — the notification's recipients. */
const ATTENDANCE_VIEW = 'community.attendance.view' as const;

/**
 * Attendance's fact, translated into notification requests — the only code in
 * this module that knows Attendance exists. Attendance knows nothing of it.
 *
 *   attendance.snapshot.recorded   ATTENDANCE_SNAPSHOT_RECORDED   the holders of
 *                                  `community.attendance.view` in the community
 *
 * Recipients are the standing holders of `community.attendance.view`, asked of
 * Communities (`COMMUNITY_CAPABILITY_HOLDERS`) at translation time — never the
 * event's `recordedBy`, never the §11.3 host/recorder view fallback, never a
 * student or ordinary participant. An event is a hint, never a grant (ADR 0021),
 * so a holder who has lost the capability since the press is simply not reached.
 * A community's holders are a bounded set, walked a page of MAX_HOLDER_PAGE at a
 * time, each page one dispatch. The recorder, if they also hold the capability,
 * IS notified — no self-suppression.
 *
 * It carries ids only: the `live_room` target (the session id) and empty params.
 * No snapshot detail, count, name, or token — the client opens the session's
 * attendance from the target.
 *
 * Deliberately **one notification per recipient per live session**: the dedupe
 * key names the session (not the snapshot), so the first snapshot of a session
 * notifies and every later snapshot of the same session is collapsed by the
 * dispatcher's `(recipient, dedupeKey)` constraint — the anti-spam rule of
 * ADR 0024, with no time window, no grouping metadata, and no update-in-place.
 * Chained per session, detached from the publisher; a malformed payload or a
 * recipient-lookup failure is logged and ignored, never thrown.
 */
@Injectable()
export class AttendanceNotificationTranslator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttendanceNotificationTranslator.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(COMMUNITY_CAPABILITY_HOLDERS) private readonly holders: CommunityCapabilityHolders,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    this.unsubscribes.push(
      this.subscriber.subscribe(AttendanceEvents.snapshotRecorded, (event) => this.schedule(event)),
    );
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** Queues translation behind the session's earlier snapshots, and returns at once. */
  schedule(event: DomainEvent): void {
    const key = event.aggregateId;
    const next = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.translate(event))
      .catch((error: unknown) =>
        this.logger.error(
          { event: event.name, aggregateId: event.aggregateId, err: error },
          'notification translation failed',
        ),
      );
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** Resolves once everything scheduled so far is translated — for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** Translates one fact now. Awaitable, for tests and a future durable consumer. */
  async translate(event: DomainEvent): Promise<void> {
    if (event.name !== AttendanceEvents.snapshotRecorded) return;
    const p = snapshotFact(event);
    if (p === null) return this.malformed(event);

    let cursor: string | null = null;
    do {
      const page = await this.holders.list(p.communityId, ATTENDANCE_VIEW, {
        cursor,
        limit: MAX_HOLDER_PAGE,
      });
      if (page.userIds.length > 0) {
        await this.dispatcher.dispatch(
          page.userIds.map((recipientUserId) => request(recipientUserId, p.liveSessionId)),
          event.correlationId,
        );
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  private malformed(event: DomainEvent): void {
    this.logger.warn({ event: event.name }, 'ignoring a malformed attendance event');
  }
}

/** One notification for one recipient, pointing at the live room by id. */
function request(recipientUserId: string, liveSessionId: string): NotificationRequest {
  return {
    recipientUserId,
    type: 'ATTENDANCE_SNAPSHOT_RECORDED',
    titleKey: titleKeyOf('ATTENDANCE_SNAPSHOT_RECORDED'),
    bodyKey: bodyKeyOf('ATTENDANCE_SNAPSHOT_RECORDED'),
    params: {},
    target: { kind: 'live_room', liveSessionId },
    // Names the SESSION, not the snapshot: one notification per recipient per
    // session, every later snapshot of the session collapsed (ADR 0024 anti-spam).
    dedupeKey: `attendance:snapshot:${liveSessionId}:user:${recipientUserId}`,
  };
}

// Events cross a module boundary: their shape is checked, not assumed. Only the
// fields this translator reads are required — the community (to scope the holder
// lookup) and the session (the target and the dedupe key).

interface SnapshotFactFields {
  readonly communityId: string;
  readonly liveSessionId: string;
}

function snapshotFact(event: DomainEvent): SnapshotFactFields | null {
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.communityId !== 'string' || typeof p.liveSessionId !== 'string') return null;
  return { communityId: p.communityId, liveSessionId: p.liveSessionId };
}
