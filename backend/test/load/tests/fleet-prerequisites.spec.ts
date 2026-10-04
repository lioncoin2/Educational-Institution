import { type PreviousRung, prerequisiteProblems } from '../fleet/prerequisites';
import { getRung } from '../scenarios/p84-ladder';

/**
 * The ladder's evidence gate: one rung per invocation, each needing the
 * previous rung's result; a failed rung stops the ladder; the nginx projection
 * (P-proj on S-ngx-share) demands S-2 before the signalling ceiling.
 */
const rung = (id: string) => {
  const r = getRung(id);
  if (!r) throw new Error(id);
  return r;
};

const prev = (over: Partial<PreviousRung> = {}): PreviousRung => ({
  rung: 'S1',
  requested: 2,
  iceMode: 'turn-free',
  verdict: 'GREEN',
  cleanupVerified: true,
  relayDetected: false,
  nginxWorkerConnections: 768,
  busiestWorkerFds: 42,
  baselineWorkerFds: 40,
  ...over,
});

describe('ladder prerequisites', () => {
  it('the S1 positive control needs nothing; forced relay is refused on any other rung', () => {
    expect(prerequisiteProblems(rung('S1'), 'relay', null, false)).toEqual([]);
    expect(prerequisiteProblems(rung('R1'), 'relay', null, false)).toEqual([
      'forced relay runs only as the S1 positive control',
    ]);
  });

  it('the TURN-free S1 needs a positive control that moved the detectors', () => {
    const control = prev({ iceMode: 'relay', verdict: 'UNKNOWN', relayDetected: true });
    expect(prerequisiteProblems(rung('S1'), 'turn-free', control, false)).toEqual([]);
    expect(prerequisiteProblems(rung('S1'), 'turn-free', null, false)[0]).toContain('--previous');
    expect(
      prerequisiteProblems(
        rung('S1'),
        'turn-free',
        { ...control, relayDetected: false },
        false,
      ).join(),
    ).toContain('did not move the TURN detectors');
    expect(prerequisiteProblems(rung('S1'), 'turn-free', prev(), false).join()).toContain(
      'positive-control',
    );
  });

  it('each later rung needs exactly the TURN-free rung before it, GREEN and cleaned', () => {
    expect(prerequisiteProblems(rung('S2'), 'turn-free', prev(), false)).toEqual([]);
    expect(prerequisiteProblems(rung('R1'), 'turn-free', prev(), false).join()).toContain(
      'needs the TURN-free S2',
    );
    expect(
      prerequisiteProblems(rung('S2'), 'turn-free', prev({ iceMode: 'relay' }), false).join(),
    ).toContain('needs the TURN-free S1');
    expect(
      prerequisiteProblems(rung('S2'), 'turn-free', prev({ cleanupVerified: false }), false).join(),
    ).toContain('cleanup was not verified');
  });

  it('a RED or UNKNOWN rung stops the ladder; YELLOW needs explicit acceptance', () => {
    for (const verdict of ['RED', 'UNKNOWN'] as const)
      expect(
        prerequisiteProblems(rung('S2'), 'turn-free', prev({ verdict }), true).join(),
      ).toContain('the ladder stops');
    expect(
      prerequisiteProblems(rung('S2'), 'turn-free', prev({ verdict: 'YELLOW' }), false).join(),
    ).toContain('--accept-yellow');
    expect(
      prerequisiteProblems(rung('S2'), 'turn-free', prev({ verdict: 'YELLOW' }), true),
    ).toEqual([]);
  });

  it('nginx projection: R4 at 768 worker_connections is not GREEN — S-2 first; after S-2 it is', () => {
    // R3 (1,000): busiest worker 260 FDs over an idle 40 → 40 + 220 × 3 = 700 FDs at R4 (91% of 768).
    const r3 = prev({ rung: 'R3', requested: 1_000, busiestWorkerFds: 260 });
    expect(prerequisiteProblems(rung('R4'), 'turn-free', r3, false).join()).toContain(
      'apply S-2 first',
    );
    expect(
      prerequisiteProblems(
        rung('R4'),
        'turn-free',
        { ...r3, nginxWorkerConnections: 40_960 },
        false,
      ),
    ).toEqual([]);
  });

  it('missing nginx evidence is refused, never assumed fine', () => {
    expect(
      prerequisiteProblems(rung('S2'), 'turn-free', prev({ busiestWorkerFds: null }), false).join(),
    ).toContain('no nginx per-worker evidence');
  });
});
