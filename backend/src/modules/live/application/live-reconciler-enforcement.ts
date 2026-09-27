import type { IdGenerator } from '../../../shared';
import { ENFORCEMENT_WATCH_SECONDS } from '../domain/live-limits';
import { currentMediaRoom, isLive, type LiveSession } from '../domain/live-session';
import type { ModerationAction } from '../domain/moderation';
import type { LiveSessionRepository } from '../domain/ports';
import {
  RtcUnavailableError,
  type RtcApplyOutcome,
  type RtcRoomProvider,
} from '../domain/rtc-provider';
import { moderationAudit, type LiveJournal } from './live-journal';
import type { LiveMedia } from './live-media';
import type { LiveSettings } from './live-settings';
import { roomSpec } from './live-reconciler-rooms';
import type { ReconcilerRuntime } from './live-reconciler-runtime';
import type { ReconcilerWatch } from './live-reconciler-watch';
import type { RoomOccupancy } from './room-occupancy';

/** What one per-identity step did. */
export interface StepOutcome {
  readonly removed?: boolean;
  readonly corrected?: boolean;
  readonly pushed?: boolean;
  readonly violation?: boolean;
  readonly reset?: boolean;
}

/**
 * What a step's comparison rests on (audit D22): the provider was observed
 * after `mark` (`LiveMedia.pushMark`), and `unchanged` says whether the
 * session stayed as it was read before that observation — live, on the same
 * epoch, at the same state version — until the standing it is compared with
 * had been read.
 */
export interface Observation {
  readonly mark: number;
  readonly unchanged: boolean;
}

/**
 * Enforcement (live.md §11.4; audit D10, D22): what the reconciler does
 * about a breach — someone not eligible to stay who is connected, or someone
 * holding more than their set. The correction is made and watched; a breach
 * seen again inside the window of a correction that applied is a violation,
 * counted, and the media reset moves the session to a new room.
 */
export class Enforcement {
  constructor(
    private readonly runtime: ReconcilerRuntime,
    private readonly watch: ReconcilerWatch,
    private readonly sessions: LiveSessionRepository,
    private readonly rooms: RtcRoomProvider,
    private readonly occupancy: RoomOccupancy,
    private readonly media: LiveMedia,
    private readonly journal: LiveJournal,
    private readonly settings: LiveSettings,
    private readonly ids: IdGenerator,
  ) {}

  /**
   * A breach: not eligible and connected, or holding more than the set.
   *
   * With no live enforcement entry, or one whose correction did not report
   * `applied` (a failed push, `not_connected`, an outage): corrected and
   * watched — not a violation (audit D22). Seen again while the entry is
   * live AND its correction applied: a violation — counted, the window
   * extended, corrected again, and the media reset (§11.4).
   *
   * But only on a current observation. The provider is observed first and
   * the standing read after, with no lock shared with moderators' commands:
   * a revoke, a yield or a presenter's close that commits in between — and
   * its own push, which may land before or after the observation — makes
   * the comparison show a breach the person never committed. So a breach
   * counts as a violation only if the session was unchanged from before the
   * observation until the standing was read (`Observation`), and no push of
   * the person's set ran meanwhile (`LiveMedia.pushedSince`): otherwise it is
   * a correction — the full set pushed and the window refreshed, nothing
   * counted and nothing reset. A genuine repeat is counted on the next tick.
   *
   * Communities needs no such guard, and steps no version. A standing lost
   * there is never pushed out of band: the provider moves only through this
   * reconciler, whose steps for a session run one at a time, so an
   * observation taken before the loss shows what the provider still held
   * when the standing was read. The breach is real either way, and the race
   * changes nothing: after an applied correction the person holds what it
   * left them, and more only through a join or a push made on standing they
   * had regained — each checked against Communities when it was made. (Who
   * regains it, joins again and loses it again inside the window is counted
   * — with or without a race: that is the rule above, not an ordering.)
   */
  async breach(
    session: LiveSession,
    userId: string,
    observation: Observation,
    now: Date,
    kind: 'removed' | 'corrected',
    correct: () => Promise<RtcApplyOutcome>,
  ): Promise<StepOutcome> {
    const violation =
      this.watch.armed(session.id, userId, now) &&
      observation.unchanged &&
      !this.media.pushedSince(session.id, userId, observation.mark);
    const until = new Date(now.getTime() + ENFORCEMENT_WATCH_SECONDS * 1000);
    if (violation) {
      const count = await this.sessions.noteViolation(session.id, now);
      this.runtime.logger.warn(
        { event: 'live.reconciler.violation', sessionId: session.id, userId, violations: count },
        'a participant breached their media rights again after a correction applied',
      );
    }
    let outcome: RtcApplyOutcome;
    try {
      outcome = await correct();
    } catch (error) {
      // No answer is not `applied`: a repeat after this is a correction.
      this.watch.remember({ sessionId: session.id, userId, until, applied: false });
      throw error;
    }
    this.watch.remember({ sessionId: session.id, userId, until, applied: outcome === 'applied' });
    this.runtime.logger.log(
      {
        event: kind === 'removed' ? 'live.reconciler.removed' : 'live.reconciler.corrected',
        sessionId: session.id,
        userId,
        outcome,
      },
      kind === 'removed'
        ? 'removed a participant no longer eligible to stay'
        : 'pushed a participant’s full media rights over more than they may hold',
    );
    const reset = violation ? await this.resetMedia(session, userId, now) : false;
    return {
      removed: kind === 'removed' && outcome === 'applied',
      corrected: kind === 'corrected' && outcome === 'applied',
      violation,
      reset,
    };
  }

  /**
   * The media reset (§11.4), at most once per violation and exactly once per
   * epoch: the compare-and-set epoch bump with its `reset_media` row decides
   * it — null means another reset, or the end, won — then the new room is
   * ensured and the old one ended. Every token the violator holds names the
   * deleted room; eligible clients follow the provider's room-deleted signal
   * and join again. A provider failure after the bump is left to the room
   * sweep: the new room is ensured as missing, the old one ends as an orphan
   * after its grace. Audited with a null actor; no event.
   *
   * Ensure-then-recheck (§4.4), as join and the room sweep do: an End — which
   * takes no lock of the reconciler's — or another reset that committed while
   * the new room was being made has ended, or will never use, the room this
   * call has just created. The session is read again: unless it is still
   * live on the new epoch, the new room is ended (best effort) and never
   * reported ensured. The old room is ended either way.
   */
  private async resetMedia(session: LiveSession, violator: string, now: Date): Promise<boolean> {
    const action: ModerationAction = {
      id: this.ids.next<'ModerationAction'>(),
      sessionId: session.id,
      actorUserId: null,
      targetUserId: violator,
      type: 'reset_media',
      at: now,
    };
    const moved = await this.sessions.bumpEpoch(session.id, session.mediaRoomEpoch, action);
    if (moved === null) return false;
    const prefix = this.settings.roomNamePrefix;
    const from = currentMediaRoom(prefix, session);
    const to = currentMediaRoom(prefix, moved);
    try {
      await this.runtime.provider(() => this.rooms.ensureRoom(roomSpec(to, moved)));
      const after = await this.sessions.findById(session.id);
      if (after !== null && isLive(after) && after.mediaRoomEpoch === moved.mediaRoomEpoch) {
        this.occupancy.ensured(to);
      } else {
        await this.endQuietly(session.id, to);
      }
      await this.runtime.provider(() => this.rooms.endRoom(from));
    } catch (error) {
      if (!(error instanceof RtcUnavailableError))
        this.runtime.logSkipped('reset', session.id, error);
    }
    const detail = { fromEpoch: session.mediaRoomEpoch, toEpoch: moved.mediaRoomEpoch };
    await this.journal.record(
      moderationAudit(action, { communityId: session.communityId, detail }),
      [],
    );
    this.runtime.logger.warn(
      {
        event: 'live.session.media_reset',
        sessionId: session.id,
        targetUserId: violator,
        ...detail,
      },
      'reset a live session’s media room after a repeated violation',
    );
    return true;
  }

  /** Ends a room nobody may use, best effort: what is left is the orphan sweep's. */
  private async endQuietly(sessionId: string, roomName: string): Promise<void> {
    try {
      await this.runtime.provider(() => this.rooms.endRoom(roomName));
    } catch (error) {
      if (!(error instanceof RtcUnavailableError))
        this.runtime.logSkipped('reset', sessionId, error);
    }
  }
}
