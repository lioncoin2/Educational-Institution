import type { LiveParticipantRole } from '../contracts/participant-role';
import type { RtcCapabilities } from './rtc-provider';

/**
 * Where someone stands in a session right now (live.md §3.6) — decided from
 * Communities' answers, identity's and Live's own records, recomputed on every
 * join and every sweep, never stored, never cached across requests, and never
 * taken from anything the client says.
 *
 *   moderator         Communities answers `community.live.moderate`, or they
 *                     are the host and it answers `community.live.host`
 *   publishesByRight  a moderator who holds identity's `live.speak` (Q54)
 *   speakerGrant      holds a granted request in this session
 *   presenter         holds the session's open presenter grant
 */
export interface ParticipantStanding {
  readonly moderator: boolean;
  readonly publishesByRight: boolean;
  readonly speakerGrant: boolean;
  readonly presenter: boolean;
}

/**
 * What a standing may do on the wire — TOTAL: every field, every time, so the
 * provider receives the full permission set and nothing is left to one of its
 * defaults (audit §8.4).
 *
 *   the microphone     a speaker grant, or a moderator publishing by right
 *   the screen         the presenter, through the one slot
 *   screen audio       never (Q56)
 *   subscribing        always: everyone listens
 *   the data channel   never: nothing uses it, and a listener must not broadcast
 *   hidden             never, until Q59 decides otherwise
 *
 * No standing ever maps to the camera: the port has no source for it.
 */
export function capabilitiesFor(standing: ParticipantStanding): RtcCapabilities {
  return {
    canPublishAudio: standing.speakerGrant || standing.publishesByRight,
    canPublishScreen: standing.presenter,
    canPublishScreenAudio: false,
    canSubscribe: true,
    canPublishData: false,
    hidden: false,
  };
}

/**
 * The role a client is shown: moderator, then speaker, then listener. The
 * host is a moderator (the view's `me.isHost` says which); a moderator without
 * `live.speak` is still a moderator, with no microphone.
 */
export function roleOf(standing: ParticipantStanding): LiveParticipantRole {
  if (standing.moderator) return 'moderator';
  return standing.speakerGrant ? 'speaker' : 'listener';
}
