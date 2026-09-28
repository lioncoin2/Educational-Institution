import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../../shared';
import { OBSERVATION_CACHE_SECONDS } from '../domain/live-limits';
import {
  RTC_ROOMS,
  RtcUnavailableError,
  type RtcRoomObservation,
  type RtcRoomProvider,
} from '../domain/rtc-provider';

/**
 * A room as a join sees it: how many are in it — the provider's count at the
 * sample, plus the listener tokens this instance issued since — or that the
 * provider does not have it, or could not say.
 */
export type RoomSample =
  | { readonly kind: 'present'; readonly occupancy: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' };

/** How many rooms' samples are kept; beyond it, expired ones are dropped first, then the oldest. */
export const ROOM_SAMPLE_LIMIT = 10_000;

/**
 * The soft cap's view of a room (live.md §12.2), per instance.
 *
 * A join may reuse a room's sample while it is younger than
 * OBSERVATION_CACHE_SECONDS, so a join storm costs one provider read per
 * room every two seconds rather than one per join; the listener tokens this
 * instance issued since the sample count against it, so a storm inside one
 * sample cannot pass the cap on this instance. Several instances, or a storm
 * inside one sample across them, may let listeners into the reserve — the
 * provider's hard cap still holds.
 *
 * Nothing here decides: the join use case refuses, ensures a missing room,
 * or fails open.
 */
@Injectable()
export class RoomOccupancy {
  private readonly samples = new Map<
    string,
    { readonly sampledAt: number; readonly count: number; issued: number }
  >();

  constructor(
    @Inject(RTC_ROOMS) private readonly rooms: RtcRoomProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The room's occupancy, from a fresh enough sample or a new one. An outage
   * is `unavailable` (a join then fails open to the hard cap); any other
   * provider failure — a configuration it refuses (`RtcMisconfiguredError`),
   * or a fault — propagates.
   */
  async sample(roomName: string): Promise<RoomSample> {
    const now = this.clock.now().getTime();
    const cached = this.samples.get(roomName);
    if (cached !== undefined && now - cached.sampledAt < OBSERVATION_CACHE_SECONDS * 1000) {
      return { kind: 'present', occupancy: cached.count + cached.issued };
    }
    let observed: readonly RtcRoomObservation[];
    try {
      observed = await this.rooms.listRooms([roomName]);
    } catch (error) {
      if (error instanceof RtcUnavailableError) return { kind: 'unavailable' };
      throw error;
    }
    const room = observed.find((candidate) => candidate.roomName === roomName);
    if (room === undefined) {
      this.samples.delete(roomName);
      return { kind: 'missing' };
    }
    this.remember(roomName, room.participantCount, now);
    return { kind: 'present', occupancy: room.participantCount };
  }

  /** The room was just ensured: nobody is in it yet. */
  ensured(roomName: string): void {
    this.remember(roomName, 0, this.clock.now().getTime());
  }

  /** A listener token was issued for the room: it counts until the next sample. */
  listenerAdmitted(roomName: string): void {
    const sample = this.samples.get(roomName);
    if (sample !== undefined) sample.issued += 1;
  }

  private remember(roomName: string, count: number, sampledAt: number): void {
    this.samples.delete(roomName);
    this.samples.set(roomName, { sampledAt, count, issued: 0 });
    if (this.samples.size <= ROOM_SAMPLE_LIMIT) return;
    const expired = sampledAt - OBSERVATION_CACHE_SECONDS * 1000;
    for (const [name, sample] of this.samples) {
      if (sample.sampledAt <= expired) this.samples.delete(name);
    }
    for (const name of this.samples.keys()) {
      if (this.samples.size <= ROOM_SAMPLE_LIMIT) break;
      this.samples.delete(name);
    }
  }
}
