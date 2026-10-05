import { isIssuedParticipantIdentity } from './live-ids';
import type { RtcParticipantObservation } from './rtc-provider';

/** A normalized presence entry: an account id and how it was connected. */
export interface NormalizedParticipant {
  readonly userId: string;
  readonly connection: 'connected' | 'connecting';
}

/**
 * `provider_registry_v1` (attendance.md §5.2, live.md §22) — pure. It turns the
 * provider's raw participant listing into the entries a snapshot keeps:
 *
 *   - **standard only** — ingress, egress, SIP, agent and recorder participants
 *     (`standard === false`) are dropped; DISCONNECTED is already dropped by the
 *     adapter, so no such state arrives here;
 *   - **account-shaped only** — an identity this application issued
 *     (`isIssuedParticipantIdentity`, a bare account id). A client-chosen
 *     identity (LiveKit's `<identity>#<publish>` trick, or anything else) is not
 *     issued and is dropped — it is nobody's;
 *   - **hidden is kept** — `hidden` is a display grant, not a connection fact;
 *     a hidden participant is a standard account like any other and is not
 *     distinguished here;
 *   - `active → connected`, `joining`/`joined → connected`'s counterpart
 *     `connecting`;
 *   - **one entry per account, CONNECTED wins** over CONNECTING, whatever order
 *     the listing arrived in (defensive against a `DUPLICATE_IDENTITY` race);
 *   - **ascending by account id**, for a determinate result.
 *
 * No provider metadata leaves this function: not the join time, published
 * sources, capabilities, LiveKit identity suffix or room — only the account id
 * and the connection state.
 */
export function normalizePresence(
  observed: readonly RtcParticipantObservation[],
): readonly NormalizedParticipant[] {
  const byAccount = new Map<string, 'connected' | 'connecting'>();
  for (const participant of observed) {
    if (!participant.standard) continue;
    if (!isIssuedParticipantIdentity(participant.identity)) continue;
    const connection = participant.state === 'active' ? 'connected' : 'connecting';
    const current = byAccount.get(participant.identity);
    if (current === undefined || connection === 'connected') {
      byAccount.set(participant.identity, connection);
    }
  }
  return [...byAccount.entries()]
    .map(([userId, connection]) => ({ userId, connection }))
    .sort((a, b) => compareIds(a.userId, b.userId));
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
