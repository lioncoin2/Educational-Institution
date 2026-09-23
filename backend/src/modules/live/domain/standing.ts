import type { LiveParticipantRole } from '../contracts/participant-role';
import { LISTENER, SPEAKER, type RtcCapabilities } from './rtc-provider';

/**
 * Where someone stands in a session right now, decided from Live's own
 * records and identity's answer — never from anything the client says.
 *
 *   the host who may speak   → moderator (publishes audio)
 *   a person with a granted hand → speaker (publishes audio)
 *   everyone else            → listener
 *
 * Recomputed on every join, so a token always reflects the current state: a
 * revoked hand re-joins as a listener, a granted one as a speaker.
 */
export function roleOf(standing: {
  readonly hostMaySpeak: boolean;
  readonly holdsGrant: boolean;
}): LiveParticipantRole {
  if (standing.hostMaySpeak) return 'moderator';
  return standing.holdsGrant ? 'speaker' : 'listener';
}

/** The full capability set a role carries. Screen share arrives with the presenter slot. */
export function capabilitiesFor(role: LiveParticipantRole): RtcCapabilities {
  return role === 'listener' ? LISTENER : SPEAKER;
}
