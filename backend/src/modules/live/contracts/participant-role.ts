/**
 * How a person takes part in a live session, as clients see it.
 *
 *   moderator — may grant, decline and revoke the floor, and end the
 *               session: a holder of `community.live.moderate` in the
 *               session's community, or the host while `community.live.host`
 *               holds (Q54). Publishes audio only while holding `live.speak`.
 *   speaker   — holds a granted hand: may publish audio until it ends.
 *   listener  — subscribes only; the default for everyone else.
 *
 * Named `LiveParticipantRole` so it cannot be confused with messaging's
 * `ParticipantRole` (a member's role in a conversation).
 */
export type LiveParticipantRole = 'moderator' | 'speaker' | 'listener';
