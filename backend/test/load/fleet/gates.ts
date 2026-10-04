/**
 * P8.4 — the global exact-N gate (design §7) as pure checks over the controller's
 * single aggregator and the server's own participant list. Connected is NOT
 * healthy: the gate needs every participant connected, the publisher published
 * and server-confirmed, every listener subscribed AND receiving, every selected
 * pair TURN-free direct UDP, and the SFU's identity set equal to the minted set
 * — so a fabricated or buggy agent report cannot pass it alone.
 */
import { type RunParticipant } from '../livekit/room-ops';
import { type MpAggregator } from '../mp/aggregate';
import { transportProblems } from '../mp/media-health';

export interface GateExpectation {
  readonly requested: number;
  readonly publisher: string;
  readonly ice: 'turn-free' | 'relay';
  readonly udpPort: number;
}

/** Server-side identity check: exactly the minted identities, all ACTIVE, publisher with one audio track. */
export function serverIdentityProblems(
  server: readonly RunParticipant[],
  minted: ReadonlySet<string>,
  publisher: string,
): string[] {
  const problems: string[] = [];
  const seen = new Set(server.map((p) => p.identity));
  const extra = [...seen].filter((id) => !minted.has(id));
  const missing = [...minted].filter((id) => !seen.has(id));
  if (extra.length > 0) problems.push(`${extra.length} unexpected identities on the SFU`);
  if (missing.length > 0) problems.push(`${missing.length} minted identities missing on the SFU`);
  const inactive = server.filter((p) => !p.active).length;
  if (inactive > 0) problems.push(`${inactive} participants not ACTIVE`);
  const pub = server.find((p) => p.identity === publisher);
  if (!pub || pub.audioTracks !== 1)
    problems.push('publisher does not hold exactly one audio track');
  return problems;
}

/** Every reported transport must satisfy the ICE mode (T2); every minted identity must have one. */
export function transportGateProblems(
  agg: MpAggregator,
  minted: ReadonlySet<string>,
  e: GateExpectation,
): string[] {
  const reports = agg.media.transports();
  const problems: string[] = [];
  const unreported = [...minted].filter((id) => !reports.has(id)).length;
  if (unreported > 0) problems.push(`${unreported} participants without a selected pair`);
  for (const [id, report] of reports)
    for (const p of transportProblems(report, { mode: e.ice, udpPort: e.udpPort }))
      problems.push(`${id}: ${p}`);
  return problems;
}

/** The client-side half of the gate (connections, publish, subscription, reception). */
export function clientGateProblems(agg: MpAggregator, e: GateExpectation): string[] {
  const listeners = e.requested - 1;
  const problems: string[] = [];
  if (agg.connected() !== e.requested) problems.push(`connected ${agg.connected()}/${e.requested}`);
  if (agg.failed() > 0) problems.push(`${agg.failed()} connect failures`);
  if (agg.crashes() > 0) problems.push(`${agg.crashes()} worker crashes`);
  if (!agg.publishersReady() || agg.publishedTrackSid(e.publisher) === undefined)
    problems.push('publisher not published');
  if (agg.media.subscribed() !== listeners)
    problems.push(`subscribed ${agg.media.subscribed()}/${listeners}`);
  if (agg.media.receiving() !== listeners)
    problems.push(`receiving ${agg.media.receiving()}/${listeners}`);
  return problems;
}
