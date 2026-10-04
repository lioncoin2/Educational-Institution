import { participantsPerRoom, totalParticipants, validateScenario } from '../core/config';
import { LOAD_ROOM_PREFIX, expandParticipants, expectedPlanSize, roomName } from '../core/identity';
import { checkScenarioSafety } from '../core/safety';
import {
  ALL_SCENARIOS,
  SCENARIOS,
  SMOKE_SCENARIOS,
  getScenario,
  scenarioIds,
} from '../scenarios/catalog';

describe('scenario catalog', () => {
  it('defines the 13 capacity scenarios plus smoke scenarios, all with unique ids', () => {
    expect(SCENARIOS).toHaveLength(13);
    expect(SMOKE_SCENARIOS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(scenarioIds()).size).toBe(ALL_SCENARIOS.length);
  });

  it('every scenario (capacity + smoke) is well-formed and within safety caps', () => {
    for (const s of ALL_SCENARIOS) {
      expect({ id: s.id, errs: validateScenario(s) }).toEqual({ id: s.id, errs: [] });
      expect({ id: s.id, safety: checkScenarioSafety(s) }).toEqual({ id: s.id, safety: [] });
    }
  });

  it('every smoke scenario is capped at 2 participants in 1 room', () => {
    for (const s of SMOKE_SCENARIOS) {
      expect({ id: s.id, rooms: s.rooms }).toEqual({ id: s.id, rooms: 1 });
      expect({ id: s.id, total: totalParticipants(s) }).toEqual({ id: s.id, total: 2 });
      expect(participantsPerRoom(s)).toBeLessThanOrEqual(2);
    }
  });

  it('covers each required kind', () => {
    expect(getScenario('api-baseline')?.target).toBe('api');
    expect(getScenario('lk-listeners-3000')?.listenersPerRoom).toBe(3000);
    const multi = getScenario('lk-multiroom-audio')!;
    expect(multi.listenersPerRoom * multi.rooms).toBe(10_000); // 10k listeners …
    expect(totalParticipants(multi)).toBe(10_020); // … + one speaker per room
    expect(getScenario('lk-relay-500')?.relay).toBe(true);
    expect(getScenario('lk-churn')?.churn?.dropFraction).toBe(0.3);
    expect(getScenario('combined')?.target).toBe('combined');
    expect(getScenario('lk-screenshare')?.screenSharesPerRoom).toBe(1);
    expect(getScenario('lk-screenshare')?.screenProfile).toBe('SCREEN_720P');
    expect(getScenario('smoke-screen')?.screenProfile).toBe('SCREEN_360P');
    expect(getScenario('smoke-relay')?.relay).toBe(true);
  });

  it('expands participants deterministically, publishers first, with non-app room prefix', () => {
    const s = getScenario('lk-speakers-4')!;
    const plan = expandParticipants(s);
    expect(plan).toHaveLength(expectedPlanSize(s));
    expect(plan).toHaveLength(totalParticipants(s));
    // first seats in a room are the speakers
    expect(plan[0]?.role).toBe('speaker');
    expect(plan[0]?.identity).toContain('speaker');
    expect(plan.every((p) => p.room.startsWith(LOAD_ROOM_PREFIX))).toBe(true);
    // rooms must NOT collide with the application prefix
    expect(roomName(s, 0).startsWith('live-staging-')).toBe(false);
    // deterministic: same expansion twice
    expect(expandParticipants(s)).toEqual(plan);
  });

  it('expands multi-room plans across all rooms', () => {
    const s = getScenario('lk-multiroom-audio')!;
    const plan = expandParticipants(s);
    expect(new Set(plan.map((p) => p.room)).size).toBe(s.rooms);
  });
});
