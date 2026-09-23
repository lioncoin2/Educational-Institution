import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared';
import {
  RTC_PARTICIPANTS,
  RtcUnavailableError,
  type RtcApplyOutcome,
  type RtcParticipantControl,
} from '../domain/rtc-provider';
import { capabilitiesFor } from '../domain/standing';
import { LiveStanding } from './live-standing';

/** How often watched participants are re-applied. */
export const CONVERGENCE_TICK_MS = 10_000;

/**
 * How long after a change a participant is watched.
 *
 * LiveKit re-issues a connected client's token at join and every five
 * minutes, each valid for ten minutes and carrying the permissions of that
 * moment (verified in the server source: `roommanager.go` refreshToken). A
 * token minted just before a change therefore stays usable for at most ten
 * minutes after it — so a client could come back within that time holding the
 * permissions it had before: a revoked speaker able to publish again, or a
 * newly granted one still muted. Watching for twelve minutes outlives every
 * such token; a join after that always goes through `/join`, which decides
 * afresh.
 */
export const CONVERGENCE_WINDOW_MS = 12 * 60_000;

/**
 * What `apply` reports: the provider's own answer, or `pending` when the
 * provider did not take the change (unreachable, or it refused and the fault
 * was logged) and the watch will keep re-applying it.
 */
export type ConvergenceOutcome = RtcApplyOutcome | 'pending';

/**
 * Keeps the media plane converged on live's own records after the floor
 * changes hands. The one place live pushes a participant's rights to the
 * media provider.
 *
 * After a grant, a revoke or a yield, `apply` pushes the person's rights at
 * once and watches them for `CONVERGENCE_WINDOW_MS`. The rights pushed —
 * at once and on every tick — are the ones their CURRENT standing calls for,
 * recomputed each time by `LiveStanding` (the same question `/join` asks),
 * never the ones the caller had in mind at the moment of the change. So a
 * host whose own hand is revoked keeps the microphone hosting gives them,
 * and a change that raced another is settled by whichever was stored last.
 * Whatever the last outcome was, a later tick puts it right:
 *
 *   - the provider was unreachable, or refused → it lands on a later tick;
 *   - they were not in the room → it lands when they come back;
 *   - they came back with an older, refreshed token → it is corrected within
 *     one tick.
 *
 * Neither `apply` nor a tick ever throws: the decision is already stored,
 * audited and announced by the caller, and a failure here is the media
 * plane lagging behind it, not the decision failing. Faults are logged by
 * class only.
 *
 * It never removes anyone. A legitimate participant — a listener, a speaker,
 * the host — is only ever given the rights their standing carries, so the
 * short join token (120 s) and this watch together cannot disconnect a person
 * who is entitled to be there. Re-applying an unchanged set is a no-op on the
 * provider.
 *
 * In process and in memory, like the rest of live until its sessions move to
 * Postgres (P6), where a level-triggered reconciler takes over this job for
 * every participant.
 */
@Injectable()
export class CapabilityConvergence implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CapabilityConvergence.name);
  /** `watchKey(sessionId, userId)` → the watch. */
  private readonly watched = new Map<
    string,
    { sessionId: string; userId: string; until: number }
  >();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly standing: LiveStanding,
    @Inject(RTC_PARTICIPANTS) private readonly participants: RtcParticipantControl,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), CONVERGENCE_TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /**
   * Pushes a person's current rights to the provider now, and watches them
   * until the media plane agrees. Called once a change to their standing is
   * stored; never throws.
   */
  async apply(sessionId: string, userId: string): Promise<ConvergenceOutcome> {
    this.watch(sessionId, userId);
    const outcome = await this.converge(sessionId, userId);
    if (outcome !== 'ended') return outcome;
    // The session ended meanwhile: nobody is in its room to tell.
    this.watched.delete(watchKey(sessionId, userId));
    return 'not_connected';
  }

  /** Starts (or extends) watching a person after their standing changed. */
  watch(sessionId: string, userId: string): void {
    this.watched.set(watchKey(sessionId, userId), {
      sessionId,
      userId,
      until: this.clock.now().getTime() + CONVERGENCE_WINDOW_MS,
    });
  }

  /** How many people are being watched — for tests and metrics. */
  get size(): number {
    return this.watched.size;
  }

  /** One pass over the watch list; single-flight, and awaitable by tests. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const [key, watch] of [...this.watched]) {
      if (now > watch.until) {
        this.watched.delete(key);
        continue;
      }
      // A failure keeps the watch: the next tick tries again.
      if ((await this.converge(watch.sessionId, watch.userId)) === 'ended') {
        this.watched.delete(key);
      }
    }
  }

  /**
   * One attempt: recompute the person's standing and push the rights it
   * carries. `ended` when the session is gone or over — nothing is left to
   * converge, and nobody is in the room to tell.
   */
  private async converge(sessionId: string, userId: string): Promise<ConvergenceOutcome | 'ended'> {
    try {
      const role = await this.standing.ofAccount(sessionId, userId);
      if (role === null) return 'ended';
      return await this.participants.updateCapabilities(sessionId, userId, capabilitiesFor(role));
    } catch (error) {
      // An outage was logged by the adapter as a warning. Anything else — a
      // refusal, or the account directory failing — is a fault worth an error,
      // named by class only: never a message, which could echo a request.
      if (!(error instanceof RtcUnavailableError)) {
        this.logger.error(
          { sessionId, err: { name: error instanceof Error ? error.name : typeof error } },
          'could not apply a participant’s live capabilities; retrying',
        );
      }
      return 'pending';
    }
  }
}

const watchKey = (sessionId: string, userId: string) => `${sessionId}\u0000${userId}`;
