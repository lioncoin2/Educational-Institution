import {
  type HarnessConfig,
  type Scenario,
  participantsPerRoom,
  totalParticipants,
  totalPublishers,
  validateScenario,
} from '../core/config';
import {
  CALIBRATION_DENSITIES,
  CALIBRATION_RUNGS,
  type FleetRequest,
  SAFETY_LIMITS,
  VALIDATED_DENSITY,
  checkFleetRequest,
  checkScenarioSafety,
  decideGate,
  fleetLimitsFor,
} from '../core/safety';
import { ALL_SCENARIOS, getScenario } from '../scenarios/catalog';
import { P84_RUNGS, type P84Rung, getRung, rungScenario } from '../scenarios/p84-ladder';

const rung = (id: string): P84Rung => getRung(id) as P84Rung;

const request = (over: Partial<FleetRequest> = {}): FleetRequest => ({
  rungId: 'R1',
  hosts: 1,
  provisionedHosts: 1,
  density: VALIDATED_DENSITY,
  provenDensity: VALIDATED_DENSITY,
  calibration: false,
  ...over,
});

const config = (scenario: Scenario): HarnessConfig => ({
  scenario,
  target: 'wss://livekit.example.net',
  allowLoad: true,
  outCsv: null,
  genOutCsv: null,
  sampleIntervalMs: 5_000,
});

describe('scenarios/p84-ladder — the decided ladder (design §14)', () => {
  it('is exactly S1..R6: N 2/20/100/300/1k/3k/5k/10k, holds 30/30/30/30/60/60/60/120, ramp 2 then 10/s', () => {
    expect(P84_RUNGS).toEqual([
      { id: 'S1', participants: 2, holdSeconds: 30, rampPerSecond: 2 },
      { id: 'S2', participants: 20, holdSeconds: 30, rampPerSecond: 10 },
      { id: 'R1', participants: 100, holdSeconds: 30, rampPerSecond: 10 },
      { id: 'R2', participants: 300, holdSeconds: 30, rampPerSecond: 10 },
      { id: 'R3', participants: 1_000, holdSeconds: 60, rampPerSecond: 10 },
      { id: 'R4', participants: 3_000, holdSeconds: 60, rampPerSecond: 10 },
      { id: 'R5', participants: 5_000, holdSeconds: 60, rampPerSecond: 10 },
      { id: 'R6', participants: 10_000, holdSeconds: 120, rampPerSecond: 10 },
    ]);
  });

  it('getRung finds each rung by its exact id and nothing else', () => {
    for (const r of P84_RUNGS) expect(getRung(r.id)).toBe(r);
    for (const id of ['R7', 'S0', 's1', 'r1', 'P84_R1', ' R1', ''])
      expect(getRung(id)).toBeUndefined();
  });

  it.each(P84_RUNGS.map((r) => [r.id, r] as const))(
    '%s as a scenario: 1 room, 1 speaker, N−1 listeners, no screen share, no API load',
    (_id, r) => {
      const s = rungScenario(r);
      expect(s).toMatchObject({
        id: `P84_${r.id}`,
        target: 'livekit',
        rooms: 1,
        speakersPerRoom: 1,
        listenersPerRoom: r.participants - 1,
        screenSharesPerRoom: 0,
        relay: false,
        rampPerSecond: r.rampPerSecond,
        holdSeconds: r.holdSeconds,
        apiConnections: 0,
        apiRequestsPerSecond: 0,
      });
      expect(s.churn).toBeUndefined();
      expect(s.screenProfile).toBeUndefined();
      expect(participantsPerRoom(s)).toBe(r.participants);
      expect(totalParticipants(s)).toBe(r.participants);
      expect(totalPublishers(s)).toBe(1);
      expect(validateScenario(s)).toEqual([]);
    },
  );

  it('rungScenario takes an operator ramp override and changes nothing else', () => {
    const r = rung('R3');
    expect(rungScenario(r, 4)).toEqual({ ...rungScenario(r), rampPerSecond: 4 });
  });

  it('the rungs are not in the general catalog: only the fleet runner can run them', () => {
    for (const r of P84_RUNGS) expect(getScenario(`P84_${r.id}`)).toBeUndefined();
    expect(ALL_SCENARIOS.some((s) => s.id.startsWith('P84'))).toBe(false);
  });
});

describe('core/safety — fleetLimitsFor: per-rung caps (D-8, no blanket raise)', () => {
  it('caps a fleet run at exactly the rung: its N in one room, one publisher, its hold and ramp, no API', () => {
    expect(fleetLimitsFor({ participants: 300, holdSeconds: 30, rampPerSecond: 10 })).toEqual({
      maxTotalParticipants: 300,
      maxParticipantsPerRoom: 300,
      maxRooms: 1,
      maxPublishersPerRoom: 1,
      maxTotalPublishers: 1,
      maxDurationSeconds: 30,
      maxRampPerSecond: 10,
      maxApiConnections: 0,
      maxApiRequestsPerSecond: 0,
    });
  });

  it.each(P84_RUNGS.map((r) => r.id))('%s: its own scenario sits exactly at its caps', (id) => {
    const r = rung(id);
    expect(checkScenarioSafety(rungScenario(r), fleetLimitsFor(r))).toEqual([]);
  });

  it.each(P84_RUNGS.map((r) => r.id))('%s: anything one step over a cap is refused', (id) => {
    const r = rung(id);
    const limits = fleetLimitsFor(r);
    const s = rungScenario(r);
    const n = r.participants;
    const over: Array<[Partial<Scenario>, string[]]> = [
      [
        { listenersPerRoom: n },
        [
          `total participants ${n + 1} exceeds cap ${n}`,
          `participants/room ${n + 1} exceeds cap ${n}`,
        ],
      ],
      [
        { holdSeconds: r.holdSeconds + 1 },
        [`duration ${r.holdSeconds + 1}s exceeds cap ${r.holdSeconds}s`],
      ],
      [
        { rampPerSecond: r.rampPerSecond + 1 },
        [`ramp ${r.rampPerSecond + 1}/s exceeds cap ${r.rampPerSecond}/s`],
      ],
      [{ apiConnections: 1 }, ['api connections 1 exceeds cap 0']],
      [{ apiRequestsPerSecond: 1 }, ['api rps 1 exceeds cap 0']],
    ];
    for (const [change, expected] of over)
      expect(checkScenarioSafety({ ...s, ...change }, limits)).toEqual(expected);
  });

  it('refuses a second room, a second speaker and a screen share', () => {
    const r = rung('R1');
    const limits = fleetLimitsFor(r);
    const s = rungScenario(r);
    expect(checkScenarioSafety({ ...s, rooms: 2 }, limits)).toEqual([
      'total participants 200 exceeds cap 100',
      'rooms 2 exceeds cap 1',
      'total publishers 2 exceeds cap 1',
    ]);
    expect(checkScenarioSafety({ ...s, speakersPerRoom: 2, listenersPerRoom: 98 }, limits)).toEqual(
      ['publishers/room 2 exceeds cap 1', 'total publishers 2 exceeds cap 1'],
    );
    expect(
      checkScenarioSafety({ ...s, screenSharesPerRoom: 1, listenersPerRoom: 98 }, limits),
    ).toEqual(['publishers/room 2 exceeds cap 1', 'total publishers 2 exceeds cap 1']);
  });

  it('a lower rung’s caps refuse every higher rung', () => {
    P84_RUNGS.forEach((lower, i) => {
      for (const higher of P84_RUNGS.slice(i + 1)) {
        const v = checkScenarioSafety(rungScenario(higher), fleetLimitsFor(lower));
        expect(v).toContain(
          `participants/room ${higher.participants} exceeds cap ${lower.participants}`,
        );
      }
    });
  });

  it('the global SAFETY_LIMITS are unchanged, and fleetLimitsFor never returns or mutates them', () => {
    const before = { ...SAFETY_LIMITS };
    const all = P84_RUNGS.map((r) => fleetLimitsFor(r));
    expect(all).not.toContain(SAFETY_LIMITS);
    expect(SAFETY_LIMITS).toEqual(before);
    expect(SAFETY_LIMITS).toEqual({
      maxTotalParticipants: 12_000,
      maxParticipantsPerRoom: 3_500,
      maxRooms: 200,
      maxPublishersPerRoom: 50,
      maxTotalPublishers: 2_000,
      maxDurationSeconds: 1_800,
      maxRampPerSecond: 200,
      maxApiConnections: 12_000,
      maxApiRequestsPerSecond: 5_000,
    });
  });

  it('under the default caps S1..R4 pass while R5 and R6 are still refused (3,500/room)', () => {
    for (const id of ['S1', 'S2', 'R1', 'R2', 'R3', 'R4'])
      expect(checkScenarioSafety(rungScenario(rung(id)))).toEqual([]);
    expect(checkScenarioSafety(rungScenario(rung('R5')))).toEqual([
      'participants/room 5000 exceeds cap 3500',
    ]);
    expect(checkScenarioSafety(rungScenario(rung('R6')))).toEqual([
      'participants/room 10000 exceeds cap 3500',
    ]);
  });

  it('the general run gate (decideGate, default caps) still refuses R5 and R6 with --allow-load', () => {
    for (const id of ['R5', 'R6']) {
      const d = decideGate(config(rungScenario(rung(id))));
      expect(d.mode).toBe('refused');
      expect(d.willGenerateLoad).toBe(false);
    }
    expect(decideGate(config(rungScenario(rung('R4')))).mode).toBe('real-load');
  });
});

describe('core/safety — checkFleetRequest: hosts, density, calibration scope', () => {
  it('the constants are the decided ones', () => {
    expect(VALIDATED_DENSITY).toBe(10);
    expect(CALIBRATION_DENSITIES).toEqual([10, 20, 30]);
    expect(CALIBRATION_RUNGS).toEqual(['S2', 'R1', 'R2']);
  });

  it('accepts one provisioned host at the validated density', () => {
    expect(checkFleetRequest(request())).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'requires at least one whole generator host (hosts=%p)',
    (hosts) => {
      expect(checkFleetRequest(request({ hosts }))).toContain(
        'at least one generator host is required',
      );
    },
  );

  it('refuses more hosts than are provisioned, and allows fewer', () => {
    expect(checkFleetRequest(request({ hosts: 3, provisionedHosts: 2 }))).toEqual([
      'hosts 3 exceeds provisioned generators 2',
    ]);
    expect(checkFleetRequest(request({ hosts: 2, provisionedHosts: 3 }))).toEqual([]);
  });

  it.each([0, -5, 2.5, Number.NaN])('requires a whole density >= 1 (density=%p)', (density) => {
    expect(checkFleetRequest(request({ density }))).toContain(
      'density must be a whole number >= 1',
    );
  });

  it('without calibration, refuses a density above the proven one and accepts it at or below', () => {
    expect(checkFleetRequest(request({ density: 11 }))).toEqual([
      'density 11 exceeds the proven density 10 (run a calibration)',
    ]);
    expect(checkFleetRequest(request({ density: 10 }))).toEqual([]);
    expect(checkFleetRequest(request({ density: 4 }))).toEqual([]);
    expect(checkFleetRequest(request({ density: 30, provenDensity: 30 }))).toEqual([]);
    expect(checkFleetRequest(request({ density: 31, provenDensity: 30 }))).toEqual([
      'density 31 exceeds the proven density 30 (run a calibration)',
    ]);
  });

  it.each(CALIBRATION_RUNGS.flatMap((id) => CALIBRATION_DENSITIES.map((d) => [id, d] as const)))(
    'calibration on %s at density %i is allowed above the proven density',
    (rungId, density) => {
      expect(checkFleetRequest(request({ rungId, density, calibration: true }))).toEqual([]);
    },
  );

  it.each(['S1', 'R3', 'R4', 'R5', 'R6', 'R7'])('calibration on %s is refused', (rungId) => {
    expect(checkFleetRequest(request({ rungId, density: 20, calibration: true }))).toEqual([
      `calibration runs only on S2/R1/R2, not ${rungId}`,
    ]);
  });

  it.each([1, 9, 11, 15, 25, 40])('calibration density %i is refused', (density) => {
    expect(checkFleetRequest(request({ rungId: 'R1', density, calibration: true }))).toEqual([
      'calibration density must be one of 10/20/30',
    ]);
  });

  it('reports every violation at once', () => {
    expect(
      checkFleetRequest({
        rungId: 'R5',
        hosts: 0,
        provisionedHosts: -1,
        density: 2.5,
        provenDensity: 10,
        calibration: true,
      }),
    ).toEqual([
      'at least one generator host is required',
      'hosts 0 exceeds provisioned generators -1',
      'density must be a whole number >= 1',
      'calibration runs only on S2/R1/R2, not R5',
      'calibration density must be one of 10/20/30',
    ]);
  });
});
