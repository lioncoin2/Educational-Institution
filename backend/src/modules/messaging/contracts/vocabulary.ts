/**
 * Messaging's public vocabulary — the words other modules, events and clients
 * use. Upper-case codes, like every other enumerated value in the API.
 */

/**
 *   DIRECT   exactly two people; fixed membership; at most one per pair
 *   GROUP    a small, managed set of people who all may write
 *   CHANNEL  a broadcast: many readers, few publishers
 */
export type ConversationType = 'DIRECT' | 'GROUP' | 'CHANNEL';

export const CONVERSATION_TYPES: readonly ConversationType[] = Object.freeze([
  'DIRECT',
  'GROUP',
  'CHANNEL',
]);

/**
 * What a message carries. Media always travels as a file reference, never as
 * bytes in the message.
 *
 * VIDEO is absent from V1 on purpose. Adding it is additive: a member here, a
 * file kind in the files policy, a typed send use case — the message and
 * attachment shapes already fit it.
 */
export type MessageType = 'TEXT' | 'VOICE' | 'IMAGE' | 'FILE';

export const MESSAGE_TYPES: readonly MessageType[] = Object.freeze([
  'TEXT',
  'VOICE',
  'IMAGE',
  'FILE',
]);

/**
 * A participant's standing inside ONE conversation — distinct from, and
 * checked in addition to, their institutional role and permissions.
 *
 *   OWNER      created it; manages who is in it
 *   PUBLISHER  may post in a channel
 *   MEMBER     takes part; in a channel, reads only
 *
 * Moderator and admin roles are the expected next members of this list.
 */
export type ParticipantRole = 'OWNER' | 'PUBLISHER' | 'MEMBER';

export const PARTICIPANT_ROLES: readonly ParticipantRole[] = Object.freeze([
  'OWNER',
  'PUBLISHER',
  'MEMBER',
]);
