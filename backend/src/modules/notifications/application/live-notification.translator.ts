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
  LIVE_AUDIENCE,
  LiveEvents,
  MAX_AUDIENCE_PROBE,
  type LiveAudience,
} from '../../live/contracts';
import type { NotificationType } from '../contracts/vocabulary';
import { bodyKeyOf, titleKeyOf } from '../domain/catalog';
import type { NotificationRequest } from '../domain/notification';
import { NotificationDispatcher } from './notification-dispatcher';

/**
 * Live's speaker facts, translated into notification requests — the only code
 * in this module that knows Live exists. Live knows nothing of it.
 *
 *   live.speaker.requested   LIVE_SPEAKER_REQUESTED   every moderator of the session
 *   live.speaker.granted     LIVE_SPEAKER_GRANTED     the requester
 *
 * `live.session.started` is deliberately NOT subscribed: its community-wide
 * fan-out is a separate, deferred slice (ADR 0024; the realtime relay already
 * delivers it to connected members). The other speaker facts
 * (declined/revoked/withdrawn/expired) and screen-share are realtime-only.
 *
 * Who the moderators are is Live's answer, asked at translation time through
 * LIVE_AUDIENCE — an event is a hint, never a grant (ADR 0021), so a moderator
 * demoted since the event is simply not reached. A session's moderators are a
 * bounded set, walked a page of MAX_AUDIENCE_PROBE at a time, each page one
 * dispatch. A grant goes to one person named in the event.
 *
 * It carries ids only: the `live_room` target (the session id). No name, token
 * or URL — never who raised the hand or who granted it; the client renders the
 * room from the target. Event semantics are preserved exactly: no recipient is
 * excluded and no grant suppressed beyond what the dispatcher decides (unknown
 * or inactive account, or the category turned off).
 *
 * Idempotent by a dedupe key that names the source request (and, for the
 * fan-out, the moderator), so the same fact delivered twice creates one
 * notification per recipient. Chained per session, detached from the publisher.
 * A malformed payload is logged and ignored, never thrown.
 */
@Injectable()
export class LiveNotificationTranslator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveNotificationTranslator.name);
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly subscriber: EventSubscriber,
    @Inject(LIVE_AUDIENCE) private readonly audience: LiveAudience,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  onModuleInit(): void {
    for (const name of [LiveEvents.speakerRequested, LiveEvents.speakerGranted]) {
      this.unsubscribes.push(this.subscriber.subscribe(name, (event) => this.schedule(event)));
    }
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  /** Queues translation behind the session's earlier facts, and returns at once. */
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
    switch (event.name) {
      case LiveEvents.speakerRequested: {
        const p = speakerFact(event, LiveEvents.speakerRequested);
        if (p === null) return this.malformed(event);
        return this.toModerators(event, p);
      }
      case LiveEvents.speakerGranted: {
        const p = speakerFact(event, LiveEvents.speakerGranted);
        if (p === null) return this.malformed(event);
        await this.dispatcher.dispatch(
          [
            request(
              'LIVE_SPEAKER_GRANTED',
              p.userId,
              p.sessionId,
              `live:speaker_granted:${p.requestId}`,
            ),
          ],
          event.correlationId,
        );
        return;
      }
      default:
        return;
    }
  }

  /**
   * Every moderator of the session now, a page at a time, each page one
   * dispatch. The set is Live's to answer; a failure to ask rejects (handled
   * by `schedule`), never a partial fan-out.
   */
  private async toModerators(event: DomainEvent, fact: SpeakerFactFields): Promise<void> {
    let cursor: string | null = null;
    do {
      const page = await this.audience.moderators(fact.sessionId, {
        cursor,
        limit: MAX_AUDIENCE_PROBE,
      });
      if (page.userIds.length > 0) {
        await this.dispatcher.dispatch(
          page.userIds.map((moderatorUserId) =>
            request(
              'LIVE_SPEAKER_REQUESTED',
              moderatorUserId,
              fact.sessionId,
              `live:speaker_requested:${fact.requestId}:user:${moderatorUserId}`,
            ),
          ),
          event.correlationId,
        );
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  private malformed(event: DomainEvent): void {
    this.logger.warn({ event: event.name }, 'ignoring a malformed live event');
  }
}

/** One notification for one recipient, pointing at the live room by id. */
function request(
  type: NotificationType,
  recipientUserId: string,
  sessionId: string,
  dedupeKey: string,
): NotificationRequest {
  return {
    recipientUserId,
    type,
    titleKey: titleKeyOf(type),
    bodyKey: bodyKeyOf(type),
    params: {},
    target: { kind: 'live_room', liveSessionId: sessionId },
    dedupeKey,
  };
}

// Events cross a module boundary: their shape is checked, not assumed. Only
// the fields this translator reads are required — the session (target and the
// moderators call), the request (dedupe) and the account a grant names.

interface SpeakerFactFields {
  readonly sessionId: string;
  readonly requestId: string;
  readonly userId: string;
}

function speakerFact(event: DomainEvent, name: string): SpeakerFactFields | null {
  const payload = event.payload;
  if (event.name !== name || payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.sessionId !== 'string' ||
    typeof p.requestId !== 'string' ||
    typeof p.userId !== 'string'
  ) {
    return null;
  }
  return { sessionId: p.sessionId, requestId: p.requestId, userId: p.userId };
}
