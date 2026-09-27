import { AdjustableClock } from '../../../../test/support/identity-harness';
import { OBSERVATION_CACHE_SECONDS } from '../domain/live-limits';
import {
  RtcUnavailableError,
  type RtcRoomObservation,
  type RtcRoomProvider,
} from '../domain/rtc-provider';
import { ROOM_SAMPLE_LIMIT, RoomOccupancy } from './room-occupancy';

/**
 * The soft cap's per-instance view of a room (live.md §12.2): one provider
 * read per room per sample, the listener tokens issued since counted on top,
 * and a bounded memory.
 */
describe('RoomOccupancy', () => {
  let clock: AdjustableClock;
  let present: Map<string, number>;
  let reads: string[][];
  let failure: Error | null;
  let occupancy: RoomOccupancy;

  beforeEach(() => {
    clock = new AdjustableClock(new Date('2026-09-27T10:00:00.000Z'));
    present = new Map([['live-a', 5]]);
    reads = [];
    failure = null;
    const rooms: RtcRoomProvider = {
      ensureRoom: async () => undefined,
      endRoom: async () => undefined,
      listRooms: async (names = []): Promise<readonly RtcRoomObservation[]> => {
        reads.push([...names]);
        if (failure !== null) throw failure;
        return names.flatMap((roomName) => {
          const participantCount = present.get(roomName);
          return participantCount === undefined
            ? []
            : [{ roomName, participantCount, createdAt: new Date(0) }];
        });
      },
    };
    occupancy = new RoomOccupancy(rooms, clock);
  });

  it('reuses a sample younger than the cache bound, counting the listeners admitted since', async () => {
    expect(await occupancy.sample('live-a')).toEqual({ kind: 'present', occupancy: 5 });
    occupancy.listenerAdmitted('live-a');
    occupancy.listenerAdmitted('live-a');
    present.set('live-a', 9);
    expect(await occupancy.sample('live-a')).toEqual({ kind: 'present', occupancy: 7 });
    expect(reads).toEqual([['live-a']]);

    // At the bound, the provider is read again, and the admissions start over.
    clock.advance(OBSERVATION_CACHE_SECONDS);
    expect(await occupancy.sample('live-a')).toEqual({ kind: 'present', occupancy: 9 });
    expect(reads).toHaveLength(2);
  });

  it('reports a missing room without remembering it, and a just-ensured one as empty', async () => {
    expect(await occupancy.sample('live-b')).toEqual({ kind: 'missing' });
    expect(await occupancy.sample('live-b')).toEqual({ kind: 'missing' });
    expect(reads).toHaveLength(2);
    occupancy.ensured('live-b');
    expect(await occupancy.sample('live-b')).toEqual({ kind: 'present', occupancy: 0 });
    expect(reads).toHaveLength(2);
  });

  it('reports an outage as unavailable, remembering nothing, and lets any other failure through', async () => {
    failure = new RtcUnavailableError('listRooms');
    expect(await occupancy.sample('live-a')).toEqual({ kind: 'unavailable' });
    failure = new Error('The media provider refused listRooms.');
    await expect(occupancy.sample('live-a')).rejects.toThrow('refused');
    failure = null;
    expect(await occupancy.sample('live-a')).toEqual({ kind: 'present', occupancy: 5 });
  });

  it('ignores an admission for a room it holds no sample of', async () => {
    occupancy.listenerAdmitted('live-a');
    expect(await occupancy.sample('live-a')).toEqual({ kind: 'present', occupancy: 5 });
  });

  it('keeps at most ROOM_SAMPLE_LIMIT rooms, dropping the oldest', async () => {
    for (let i = 0; i <= ROOM_SAMPLE_LIMIT; i += 1) occupancy.ensured(`live-${i}`);
    present.set('live-0', 3);
    // The oldest was dropped, so it is read afresh; the newest is still remembered.
    expect(await occupancy.sample('live-0')).toEqual({ kind: 'present', occupancy: 3 });
    expect(await occupancy.sample(`live-${ROOM_SAMPLE_LIMIT}`)).toEqual({
      kind: 'present',
      occupancy: 0,
    });
    expect(reads).toEqual([['live-0']]);
  });
});
