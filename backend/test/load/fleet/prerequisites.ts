/**
 * P8.4 — the ladder's evidence gate (design §14): one rung per invocation, and
 * a rung may start only with the PREVIOUS rung's result attached. Pure.
 *
 *  - S1 (forced relay) is the positive control and needs nothing; it must show
 *    that the TURN detectors moved before the TURN-free S1 may run (D-3).
 *  - Every later rung needs the immediately lower rung's result: TURN-free,
 *    cleanup verified, GREEN — or YELLOW only with an explicit `--accept-yellow`
 *    (verdict table: a YELLOW rung stops the ladder by default). RED or UNKNOWN
 *    stops the ladder: no retry, no skipping.
 *  - nginx (P-proj, design §15): the busiest worker's participant-driven FDs
 *    (above its idle baseline) scaled by the participant ratio — 4 connections
 *    per WebSocket, arithmetic rather than a capacity assumption — plus that
 *    baseline must stay GREEN on S-ngx-share; otherwise S-2 is required first.
 */
import { RULES, levelOf } from '../observe/rules';
import { type RungResult } from '../results/schema';
import { P84_RUNGS, type P84Rung } from '../scenarios/p84-ladder';

export interface PreviousRung {
  readonly rung: string;
  readonly requested: number;
  readonly iceMode: 'turn-free' | 'relay';
  readonly verdict: RungResult['verdict']['class'];
  readonly cleanupVerified: boolean;
  /** The positive control proved the detectors: a relay candidate or relay socket was seen. */
  readonly relayDetected: boolean;
  readonly nginxWorkerConnections: number | null;
  readonly busiestWorkerFds: number | null;
  /** The busiest worker's idle FDs (rung baseline): the part that does not scale with participants. */
  readonly baselineWorkerFds: number | null;
}

export function previousOf(r: RungResult): PreviousRung {
  return {
    rung: r.meta.rung,
    requested: r.meta.requested,
    iceMode: r.profile.iceMode,
    verdict: r.verdict.class,
    cleanupVerified: r.cleanup.verified,
    relayDetected: r.transport.relayCandidates > 0 || (r.transport.relaySocketsMax ?? 0) > 0,
    nginxWorkerConnections: r.nginx.workerConnections,
    busiestWorkerFds: r.nginx.busiestWorkerFdsMax,
    baselineWorkerFds: r.nginx.baselineWorkerFdsMax,
  };
}

const NGINX_SHARE = RULES.find((r) => r.id === 'S-ngx-share');

export function prerequisiteProblems(
  rung: P84Rung,
  ice: 'turn-free' | 'relay',
  previous: PreviousRung | null,
  acceptYellow: boolean,
): string[] {
  if (ice === 'relay')
    return rung.id === 'S1' ? [] : ['forced relay runs only as the S1 positive control'];
  if (!previous) return [`${rung.id} needs --previous <result.json> of the rung before it`];
  if (rung.id === 'S1') {
    if (previous.rung !== 'S1' || previous.iceMode !== 'relay')
      return ['the TURN-free S1 needs the S1 forced-relay positive-control result (D-3)'];
    const p: string[] = [];
    if (!previous.relayDetected)
      p.push(
        'the positive control did not move the TURN detectors — the proof method is wrong; P8.4 stops',
      );
    if (!previous.cleanupVerified) p.push('the positive control cleanup was not verified');
    return p;
  }
  const order = P84_RUNGS.map((r) => r.id);
  const expected = order[order.indexOf(rung.id) - 1];
  const p: string[] = [];
  if (previous.rung !== expected || previous.iceMode !== 'turn-free')
    p.push(
      `${rung.id} needs the TURN-free ${expected} result, got ${previous.rung} (${previous.iceMode})`,
    );
  if (!previous.cleanupVerified) p.push(`${previous.rung} cleanup was not verified`);
  if (previous.verdict === 'RED' || previous.verdict === 'UNKNOWN')
    p.push(
      `${previous.rung} was ${previous.verdict}: the ladder stops for diagnosis (no retry, no skipping)`,
    );
  if (previous.verdict === 'YELLOW' && !acceptYellow)
    p.push(`${previous.rung} was YELLOW: continuing needs an explicit --accept-yellow approval`);
  if (NGINX_SHARE && previous.busiestWorkerFds !== null && previous.nginxWorkerConnections) {
    // Only the participant-driven FDs scale; the idle baseline stays (missing baseline: scale all).
    const fixed = Math.min(previous.baselineWorkerFds ?? 0, previous.busiestWorkerFds);
    const projected =
      fixed + ((previous.busiestWorkerFds - fixed) * rung.participants) / previous.requested;
    const share = (projected / previous.nginxWorkerConnections) * 100;
    if (levelOf(NGINX_SHARE, share) !== 'green')
      p.push(
        `nginx busiest-worker projection ${Math.round(share)}% of worker_connections is not GREEN (P-proj): apply S-2 first`,
      );
  } else {
    p.push(`${previous.rung} result has no nginx per-worker evidence for the P-proj projection`);
  }
  return p;
}
