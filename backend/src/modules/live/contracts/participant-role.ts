/**
 * How a person participates in a live session.
 *
 * Declared in contracts because other modules (reporting, operations) interpret
 * it when reacting to live events; the domain imports it from here.
 */
export type ParticipantRole = 'host' | 'speaker' | 'listener';
