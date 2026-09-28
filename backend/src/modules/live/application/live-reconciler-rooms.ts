import type { Clock } from '../../../shared';
import {
  IDLE_END_SECONDS,
  ORPHAN_GRACE_SECONDS,
  ROOM_PROVIDER_TIMEOUT_SECONDS,
} from '../domain/live-limits';
import {
  currentMediaRoom,
  isLive,
  parseMediaRoomName,
  type LiveSession,
} from '../domain/live-session';
import type { LiveSessionRepository } from '../domain/ports';
import {
  RtcMisconfiguredError,
  RtcUnavailableError,
  type RtcRoomObservation,
  type RtcRoomProvider,
  type RtcRoomSpec,
} from '../domain/rtc-provider';
import type { LiveMediaReadiness } from './live-media-readiness';
import type { LiveSessionLifecycle } from './live-session-lifecycle';
import type { LiveSettings } from './live-settings';
import { emptyRooms, type RoomSweepReport } from './live-reconciler-reports';
import type { ReconcilerRuntime } from './live-reconciler-runtime';
import type { ReconcilerWatch } from './live-reconciler-watch';
import type { RoomOccupancy } from './room-occupancy';

/**
 * The room sweep (live.md §11.2; audit D23), every ROOM_SWEEP_SECONDS: a
 * live session's missing room is ensured, then the session re-read (§4.4);
 * `empty_since` is kept, and a room empty for IDLE_END_SECONDS ends its
 * session `idle`; a room of this deployment's form that no live session
 * claims is ended after ORPHAN_GRACE_SECONDS.
 *
 * Never on an incomplete picture: without every live session, or without
 * the room list, it does nothing at all — an unread session would make its
 * live room look orphaned.
 *
 * Each sweep first refreshes the provider's self-check — the answer Start's
 * gate reads (`LiveMediaReadiness`, P7.1) — so a Start, which accepts an
 * answer no older than a sweep, seldom has to wait for one. A provider whose
 * answers are positively not LiveKit's is not read at all (see `run`).
 */
export class RoomSweep {
  constructor(
    private readonly runtime: ReconcilerRuntime,
    private readonly watch: ReconcilerWatch,
    private readonly sessions: LiveSessionRepository,
    private readonly rooms: RtcRoomProvider,
    private readonly occupancy: RoomOccupancy,
    private readonly lifecycle: LiveSessionLifecycle,
    private readonly settings: LiveSettings,
    private readonly clock: Clock,
    private readonly readiness: LiveMediaReadiness,
  ) {}

  /** One sweep. Whatever it throws, the tick's single flight reports as `failed`. */
  async run(): Promise<RoomSweepReport> {
    // The self-check first. It never rejects, and may take a request's
    // timeout. An endpoint that answers but is positively not LiveKit — a
    // wrong LIVEKIT_API_URL that says 200 to everything — must never be read:
    // its empty room list would make every live session's room look missing,
    // and end each session idle. Only LiveKit's own answer says a room is
    // absent (P7.1, decision 5). Every other not-ready answer reaches the
    // calls below, which fail, and skip, on their own.
    const readiness = await this.readiness.refresh();
    if (!readiness.ready && readiness.reason === 'incompatible_response') {
      return emptyRooms('provider_incompatible');
    }
    return this.sweep();
  }

  private async sweep(): Promise<RoomSweepReport> {
    // 1. Every live session, or nothing at all: an incomplete set would make
    //    a live room look orphaned (audit D23). The orphans' grace (step 4) is
    //    measured from this read, not from the end of the sweep: a session
    //    started after it has a room listed below but is not claimed here,
    //    and the grace protects it only while it counts from before its start
    //    — however long the steps between take.
    const readAt = this.clock.now();
    let live: readonly LiveSession[];
    try {
      live = await this.runtime.allLiveSessions();
    } catch (error) {
      this.runtime.logTickSkipped('rooms', error);
      return emptyRooms('failed');
    }
    // 2. One list of rooms; only this deployment's are ever looked at.
    let listed: readonly RtcRoomObservation[];
    try {
      listed = await this.runtime.provider(() => this.rooms.listRooms());
    } catch (error) {
      const stop = providerStop(error);
      if (stop === null) this.runtime.logTickSkipped('rooms', error);
      return { ...emptyRooms(stop ?? 'failed'), sessions: live.length };
    }
    const prefix = this.settings.roomNamePrefix;
    const ours = new Map(
      listed
        .filter((room) => parseMediaRoomName(prefix, room.roomName) !== null)
        .map((room) => [room.roomName, room]),
    );

    // 3. Each live session's current room.
    let sessionsSkipped = 0;
    let ensured = 0;
    let idleEnded = 0;
    for (const session of live) {
      let step: RoomStep;
      try {
        step = await this.runtime.perSession.run(session.id, () =>
          this.roomStep(session, ours.get(currentMediaRoom(prefix, session)) ?? null),
        );
      } catch (error) {
        const stop = providerStop(error);
        if (stop !== null) {
          return {
            skipped: stop,
            sessions: live.length,
            sessionsSkipped,
            ensured,
            idleEnded,
            orphansEnded: 0,
          };
        }
        this.runtime.logSkipped('rooms', session.id, error);
        sessionsSkipped += 1;
        continue;
      }
      if (step.ensured) ensured += 1;
      if (step.idleEnded) idleEnded += 1;
    }

    // 4. Orphans: this deployment's rooms no live session claims, past the
    //    grace that protects a start still in flight — old epochs of a reset
    //    session among them.
    const claimed = new Set(live.map((session) => currentMediaRoom(prefix, session)));
    const graceEnds = readAt.getTime() - ORPHAN_GRACE_SECONDS * 1000;
    let orphansEnded = 0;
    for (const room of ours.values()) {
      if (claimed.has(room.roomName) || room.createdAt.getTime() > graceEnds) continue;
      const parsed = parseMediaRoomName(prefix, room.roomName);
      if (parsed === null) continue;
      try {
        await this.runtime.perSession.run(parsed.sessionId, () =>
          this.runtime.provider(() => this.rooms.endRoom(room.roomName)),
        );
      } catch (error) {
        const stop = providerStop(error);
        if (stop !== null) {
          return {
            skipped: stop,
            sessions: live.length,
            sessionsSkipped,
            ensured,
            idleEnded,
            orphansEnded,
          };
        }
        this.runtime.logSkipped('rooms', parsed.sessionId, error);
        continue;
      }
      orphansEnded += 1;
      this.runtime.logger.log(
        { event: 'live.reconciler.orphan_ended', sessionId: parsed.sessionId, epoch: parsed.epoch },
        'ended a media room no live session claims',
      );
    }
    return {
      skipped: null,
      sessions: live.length,
      sessionsSkipped,
      ensured,
      idleEnded,
      orphansEnded,
    };
  }

  /**
   * One live session's room, under the session's lock. `observed` is the
   * room as the sweep's one list saw it; null when it was missing.
   */
  private async roomStep(
    listed: LiveSession,
    observed: RtcRoomObservation | null,
  ): Promise<RoomStep> {
    const session = await this.sessions.findById(listed.id);
    // Ended, or moved to a new room by a reset since the list: the room seen
    // is not its current one, and the next sweep looks again.
    if (session === null || !isLive(session) || session.mediaRoomEpoch !== listed.mediaRoomEpoch) {
      return {};
    }
    const room = currentMediaRoom(this.settings.roomNamePrefix, session);
    const now = this.clock.now();
    let ensured = false;
    if (observed === null) {
      // Ensure-then-recheck (§4.4): an end, or a reset, that committed while
      // the room was being made leaves it nobody's.
      await this.runtime.provider(() => this.rooms.ensureRoom(roomSpec(room, session)));
      const after = await this.sessions.findById(session.id);
      if (after === null || !isLive(after) || after.mediaRoomEpoch !== session.mediaRoomEpoch) {
        await this.runtime.provider(() => this.rooms.endRoom(room));
        return {};
      }
      this.occupancy.ensured(room);
      ensured = true;
      this.runtime.logger.log(
        {
          event: 'live.reconciler.room_ensured',
          sessionId: session.id,
          epoch: session.mediaRoomEpoch,
        },
        'ensured a live session’s missing media room',
      );
    }
    // A missing room counts as observed empty, so a session whose room keeps
    // disappearing still ends idle.
    const empty = observed === null || observed.participantCount === 0;
    const emptySince = session.emptySince;
    if (
      empty &&
      emptySince !== null &&
      now.getTime() - emptySince.getTime() >= IDLE_END_SECONDS * 1000
    ) {
      await this.lifecycle.endBySystem(session.id, 'idle');
      this.watch.forget(session.id);
      this.runtime.logger.log(
        { event: 'live.reconciler.session_ended', sessionId: session.id, reason: 'idle' },
        'ended a live session whose room stayed empty',
      );
      return { ensured, idleEnded: true };
    }
    // The repository keeps a date already set; writing only on a change
    // spares a statement per session per tick.
    if (empty && emptySince === null) await this.sessions.markEmpty(session.id, now);
    if (!empty && emptySince !== null) await this.sessions.markEmpty(session.id, null);
    return { ensured };
  }
}

interface RoomStep {
  readonly ensured?: boolean;
  readonly idleEnded?: boolean;
}

/**
 * A failure every other room would meet too — an outage, or a configuration
 * the provider refuses (P7.2, Q-B), each logged once by the runtime — so the
 * sweep stops; null for anything else.
 */
function providerStop(error: unknown): 'provider_unavailable' | 'provider_misconfigured' | null {
  if (error instanceof RtcUnavailableError) return 'provider_unavailable';
  if (error instanceof RtcMisconfiguredError) return 'provider_misconfigured';
  return null;
}

/**
 * The room a live session is given — by this sweep and by a media reset:
 * its cap plus its reserve, and the provider's own timeouts as a backstop.
 */
export function roomSpec(roomName: string, session: LiveSession): RtcRoomSpec {
  return {
    roomName,
    maxParticipants: session.participantCap + session.moderatorReserve,
    emptyTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
    departureTimeoutSeconds: ROOM_PROVIDER_TIMEOUT_SECONDS,
  };
}
