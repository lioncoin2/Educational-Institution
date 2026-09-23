/**
 * How a person takes part in a live session, as clients see it.
 *
 *   moderator — may grant, decline and revoke the floor; publishes audio.
 *               Today only the room's host is one (host-only moderation, Q1).
 *   speaker   — holds a granted hand: may publish audio until it ends.
 *   listener  — subscribes only; the default for everyone else.
 *
 * Named `LiveParticipantRole` so it cannot be confused with messaging's
 * `ParticipantRole` (a member's role in a conversation).
 */
export type LiveParticipantRole = 'moderator' | 'speaker' | 'listener';
