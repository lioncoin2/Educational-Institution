import { Inject, Injectable } from '@nestjs/common';

import type { DomainEvent } from '../../../shared';
import { currentMediaRoom, isLive, type LiveSession } from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import { LIVE_SESSION_REPOSITORY, type LiveSessionRepository } from '../domain/ports';
import { RTC_ROOMS, type RtcRoomProvider } from '../domain/rtc-provider';
import { LiveJournal, moderationAudit } from './live-journal';
import { roomSpec } from './live-reconciler-rooms';
import { LIVE_SETTINGS, type LiveSettings } from './live-settings';
import { RoomOccupancy } from './room-occupancy';

/**
 * How a caller runs the two provider calls of the swap, and what it does with a
 * provider failure after the epoch has moved. The reconciler passes its own
 * `ReconcilerRuntime.provider` (so the provider's up/down state keeps being
 * logged once on change) and its `logSkipped`; a request-time use case passes a
 * pass-through and its own logger. Either way the epoch is already committed, so
 * the swap is best effort and a failure is left to the room sweep.
 */
export interface MediaRoomResetHooks {
  runProvider<T>(call: () => Promise<T>): Promise<T>;
  onSkipped(error: unknown): void;
}

export interface MediaRoomResetInput {
  readonly session: LiveSession;
  /** The `reset_media` action — `actorUserId` null for the reconciler, the moderator for the command. */
  readonly action: ModerationAction;
  /** Extra audit detail (e.g. the moderator's permit); merged after `{ fromEpoch, toEpoch }`. */
  readonly detail?: Record<string, unknown>;
  readonly correlationId?: string;
  /** The events to publish with the audit — none for the reconciler, the reset fact for the command. */
  readonly eventsFor?: (from: LiveSession, to: LiveSession) => readonly DomainEvent[];
  readonly hooks: MediaRoomResetHooks;
}

/**
 * The media-room reset's room-swap orchestration (live.md §11.4), owned once and
 * shared (ADR 0026, extending ADR 0019): the compare-and-set epoch bump with its
 * `reset_media` row, then the new-epoch room ensured and the old one ended
 * (ensure-then-recheck, §4.4), the occupancy sample seeded, and the audit — with
 * whatever events the caller supplies — written through the one journal.
 *
 * Both the reconciler's automatic reset (ADR 0019, on a repeated violation,
 * system actor, no event) and the moderator/teacher command (Q64, a moderator
 * actor, the `live.session.media_reset` fact) call this. Each supplies its own
 * `ModerationAction`, events and provider `hooks`, and logs its own
 * `live.session.media_reset` line. This service never decides authorization and
 * logs no reset line of its own: the existing epoch mechanism and stale-room
 * protection (the old room is deleted, `auto_create` is off) are unchanged.
 *
 * Returns the moved session, or null when the compare-and-set lost — the session
 * is gone, is not live, or another reset or the end already moved the epoch.
 */
@Injectable()
export class LiveMediaReset {
  constructor(
    @Inject(LIVE_SESSION_REPOSITORY) private readonly sessions: LiveSessionRepository,
    @Inject(RTC_ROOMS) private readonly rooms: RtcRoomProvider,
    private readonly occupancy: RoomOccupancy,
    private readonly journal: LiveJournal,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
  ) {}

  async reset(input: MediaRoomResetInput): Promise<LiveSession | null> {
    const { session, action, hooks } = input;
    const moved = await this.sessions.bumpEpoch(session.id, session.mediaRoomEpoch, action);
    if (moved === null) return null;

    const prefix = this.settings.roomNamePrefix;
    const from = currentMediaRoom(prefix, session);
    const to = currentMediaRoom(prefix, moved);
    try {
      await hooks.runProvider(() => this.rooms.ensureRoom(roomSpec(to, moved)));
      const after = await this.sessions.findById(session.id);
      if (after !== null && isLive(after) && after.mediaRoomEpoch === moved.mediaRoomEpoch) {
        this.occupancy.ensured(to);
      } else {
        await this.endQuietly(to, hooks);
      }
      await hooks.runProvider(() => this.rooms.endRoom(from));
    } catch (error) {
      hooks.onSkipped(error);
    }

    const detail = {
      fromEpoch: session.mediaRoomEpoch,
      toEpoch: moved.mediaRoomEpoch,
      ...input.detail,
    };
    await this.journal.record(
      moderationAudit(action, {
        communityId: session.communityId,
        detail,
        correlationId: input.correlationId,
      }),
      input.eventsFor ? [...input.eventsFor(session, moved)] : [],
    );
    return moved;
  }

  /** Ends a room nobody may use, best effort; what is left is the orphan sweep's. */
  private async endQuietly(roomName: string, hooks: MediaRoomResetHooks): Promise<void> {
    try {
      await hooks.runProvider(() => this.rooms.endRoom(roomName));
    } catch (error) {
      hooks.onSkipped(error);
    }
  }
}
