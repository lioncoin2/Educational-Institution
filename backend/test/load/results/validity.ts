/**
 * P8.4 — the validity checks (verdict table "Validity", V-*) and the window in
 * which observations are judged. A failed check makes the rung UNKNOWN: the
 * evidence cannot support a SUT capacity statement (design §13). Pure; every
 * number comes from observe/rules.ts.
 */
import { transportProblems } from '../mp/media-health';
import { samplerSanity } from '../observe/derive';
import { CLOCK_RED_MS, TRIGGER_LOOKBACK_MS, type ValidityId } from '../observe/rules';
import { type HostSample } from '../observe/sample';
import { type RunMonitor } from '../fleet/monitor';
import { type AssembleInput } from './assemble-input';
import { type RungResult } from './schema';
import { maxOf } from './series';

/** Controller aborts that put the harness, not the SUT, in doubt (V-sampler: harness integrity). */
const INTEGRITY_ABORTS: ReadonlySet<string> = new Set([
  'identity-scope',
  'server-identity',
  'controller-error',
]);

/**
 * The non-GREEN observations that count: inside the hold, or within the
 * trigger lookback before the first abort / gate failure. Start-up transients
 * (process spawn, ts-node compile) before either window are not judged.
 */
export function judged(i: AssembleInput): RunMonitor['notGreen'] {
  const { holdStart, holdEnd } = i.times;
  const trigger = i.abort?.at ?? i.failureAt;
  return i.monitor.notGreen.filter(
    (o) =>
      (holdStart !== null && o.at >= holdStart && o.at <= (holdEnd ?? Infinity)) ||
      (trigger !== null && o.at >= trigger - TRIGGER_LOOKBACK_MS && o.at <= trigger),
  );
}

function turnProblems(
  i: AssembleInput,
  sut: readonly HostSample[],
  gens: readonly HostSample[],
): string[] {
  if (i.req.ice === 'relay') return ['forced-relay positive control: not a capacity run'];
  const problems: string[] = [];
  for (const [id, r] of i.agg.media.transports())
    for (const p of transportProblems(r, { mode: 'turn-free', udpPort: i.req.udpPort }))
      problems.push(`${id}: ${p}`);
  if ((maxOf(sut.map((s) => s.sut?.relaySockets)) ?? 0) > 0)
    problems.push('relay sockets on the SUT (T5)');
  if ((maxOf(sut.map((s) => s.sut?.turnTlsEstab)) ?? 0) > 0)
    problems.push('TURN/TLS connections (T7)');
  if ((maxOf(gens.map((s) => s.gen?.flowsToSut3478)) ?? 0) > 0)
    problems.push('generator flows to SUT:3478 (T6)');
  if ((i.post.log?.relayPairs ?? 0) > 0) problems.push('relay pairs in the LiveKit log (T3)');
  if ((i.post.log?.turnQuota ?? 0) > 0) problems.push('TURN quota lines (T4)');
  return problems;
}

/** Sampler integrity: each sampler's own series (SUT, then every agent), never regrouped by name. */
function samplerProblems(i: AssembleInput, sut: readonly HostSample[]): string[] {
  const integrity = INTEGRITY_ABORTS.has(i.abort?.rule ?? '')
    ? [`${i.abort?.rule}: ${i.abort?.detail ?? ''}`]
    : [];
  return [
    ...integrity,
    ...(i.post.log === null ? ['LiveKit log unavailable: T3/T4/M-unbound/V-dup unverifiable'] : []),
    ...i.hellos
      .filter((h) => !i.monitor.judgedAgents.has(h.index))
      .map((h) => `generator rules never evaluated for agent ${h.index}`),
    ...[sut, ...i.monitor.genSamples.values()].flatMap((series) => samplerSanity(series)),
    ...[...i.monitor.missing].map((m) => `missing ${m}`),
  ];
}

export function validityOf(
  i: AssembleInput,
  sut: readonly HostSample[],
  gens: readonly HostSample[],
): RungResult['validity'] {
  const turn = turnProblems(i, sut, gens);
  const genFired = i.monitor.fired.filter((f) => f.scope === 'generator').map((f) => f.ruleId);
  // V-gen judges the generator over the hold and the lookback before the first trigger (design §13).
  const genYellow = [
    ...new Set(
      judged(i)
        .filter((o) => o.scope === 'generator')
        .map((o) => o.ruleId),
    ),
  ];
  const sampler = samplerProblems(i, sut);
  const clock = maxOf(
    gens.map((s) => (s.clockOffsetMs === null ? null : Math.abs(s.clockOffsetMs))),
  );
  const dupFaults = i.agg.media.faults().filter((f) => f.reason === 'DUPLICATE_IDENTITY').length;
  const dupLog = i.post.log?.duplicateParticipant ?? null;
  const sutFired = i.monitor.fired.some((f) => f.scope === 'sut');
  // A gate failure during the ramp with no SUT rule fired and no LiveKit error lines: ramp-induced suspected.
  const rampInduced =
    i.gateFailure !== null &&
    i.times.rampStart !== null &&
    !sutFired &&
    (i.post.log?.errorLines ?? 0) === 0;
  const v = (ok: boolean, detail: string): { ok: boolean; detail: string } => ({ ok, detail });
  const entries: Record<ValidityId, { ok: boolean; detail: string }> = {
    'V-turn': v(
      turn.length === 0 && i.abort?.rule !== 'V-turn',
      turn.slice(0, 5).join('; ') || 'ok',
    ),
    'V-gen': v(
      genFired.length === 0 && genYellow.length === 0 && i.abort?.rule !== 'agent-lost',
      [...genFired, ...genYellow].join(', ') ||
        (i.abort?.rule === 'agent-lost' ? i.abort.detail : 'ok'),
    ),
    'V-sampler': v(sampler.length === 0, sampler.slice(0, 5).join('; ') || 'ok'),
    'V-clock': v(
      clock !== null && clock < CLOCK_RED_MS,
      clock === null ? 'clock offset unknown' : `max ${clock} ms`,
    ),
    'V-dup': v(dupFaults === 0 && dupLog === 0, `faults ${dupFaults}, log ${dupLog ?? 'unknown'}`),
    'V-ticket': v(
      i.post.ticketLeaks === 0,
      `access_token lines from generators: ${i.post.ticketLeaks ?? 'unknown'}`,
    ),
    'V-ramp': v(!rampInduced, rampInduced ? `ramp-induced suspected: ${i.gateFailure}` : 'ok'),
  };
  return entries;
}
