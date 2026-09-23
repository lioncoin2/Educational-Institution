import { err, failure, ok, type Result } from '../../../shared';
import type { ConversationType, ParticipantRole } from '../contracts/vocabulary';
import { MAX_PARTICIPANTS, TITLE_MAX_LENGTH } from './messaging-policy';
import type { ConversationId } from './ids';
import { newParticipant, type Participant } from './participant';

export type { ConversationId } from './ids';

/** A direct conversation's two members, ordered, so {A,B} and {B,A} are one pair. */
export interface DirectPair {
  readonly low: string;
  readonly high: string;
}

/**
 * A conversation: a place messages are appended to, in one server-decided
 * order, readable by its current members.
 *
 * `lastSequence` is the ordering authority. Every message gets the next
 * integer, assigned under the conversation's row lock — see messaging.md,
 * "Ordering". `memberCount` is kept in the same transactions as membership, so
 * caps are enforced without counting rows.
 */
export interface Conversation {
  readonly id: ConversationId;
  readonly type: ConversationType;
  /** Null for DIRECT: its name is the other person's, and differs per viewer. */
  readonly title: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly directPair: DirectPair | null;
  readonly lastSequence: number;
  readonly lastMessageAt: Date | null;
  readonly memberCount: number;
}

export interface NewConversation {
  readonly conversation: Conversation;
  readonly participants: readonly Participant[];
}

const invalid = (code: string, message: string, details?: Record<string, unknown>) =>
  err(failure('validation', `messaging.${code}`, message, details));

export function directPairOf(a: string, b: string): Result<DirectPair> {
  if (a === b) return invalid('direct_with_self', 'A direct conversation needs two people.');
  return ok(a < b ? { low: a, high: b } : { low: b, high: a });
}

/** Trimmed, single-line, control-free, bounded. */
export function normalizeTitle(raw: string): Result<string> {
  const title = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length === 0) return invalid('title_required', 'A title is required.');
  if ([...title].length > TITLE_MAX_LENGTH) {
    return invalid('title_too_long', `A title is at most ${TITLE_MAX_LENGTH} characters.`, {
      maxLength: TITLE_MAX_LENGTH,
    });
  }
  return ok(title);
}

function conversation(
  fields: Pick<Conversation, 'id' | 'type' | 'title' | 'createdBy' | 'createdAt' | 'directPair'>,
  memberCount: number,
): Conversation {
  return { ...fields, lastSequence: 0, lastMessageAt: null, memberCount };
}

export function newDirectConversation(input: {
  readonly id: ConversationId;
  readonly initiator: string;
  readonly counterpart: string;
  readonly at: Date;
}): Result<NewConversation> {
  const pair = directPairOf(input.initiator, input.counterpart);
  if (!pair.ok) return pair;
  const created = conversation(
    {
      id: input.id,
      type: 'DIRECT',
      title: null,
      createdBy: input.initiator,
      createdAt: input.at,
      directPair: pair.value,
    },
    2,
  );
  return ok({
    conversation: created,
    participants: [
      newParticipant(created, input.initiator, 'MEMBER', input.initiator, input.at),
      newParticipant(created, input.counterpart, 'MEMBER', input.initiator, input.at),
    ],
  });
}

export function newGroupConversation(input: {
  readonly id: ConversationId;
  readonly creator: string;
  readonly title: string;
  readonly memberIds: readonly string[];
  readonly at: Date;
}): Result<NewConversation> {
  return managedConversation('GROUP', input, { members: input.memberIds, publishers: [] });
}

export function newChannelConversation(input: {
  readonly id: ConversationId;
  readonly creator: string;
  readonly title: string;
  readonly memberIds: readonly string[];
  readonly publisherIds: readonly string[];
  readonly at: Date;
}): Result<NewConversation> {
  return managedConversation('CHANNEL', input, {
    members: input.memberIds,
    publishers: input.publisherIds,
  });
}

/**
 * The creator becomes OWNER. Everyone else joins as MEMBER, or PUBLISHER when
 * named as one (channels). Naming someone twice, or the creator at all, is
 * harmless: each person is in the result once, with their highest role.
 */
function managedConversation(
  type: 'GROUP' | 'CHANNEL',
  input: {
    readonly id: ConversationId;
    readonly creator: string;
    readonly title: string;
    readonly at: Date;
  },
  people: { readonly members: readonly string[]; readonly publishers: readonly string[] },
): Result<NewConversation> {
  const title = normalizeTitle(input.title);
  if (!title.ok) return title;

  const roles = new Map<string, ParticipantRole>();
  for (const id of people.members) roles.set(id, 'MEMBER');
  for (const id of people.publishers) roles.set(id, 'PUBLISHER');
  roles.set(input.creator, 'OWNER');

  if (roles.size > MAX_PARTICIPANTS[type]) {
    return err(
      failure(
        'precondition_failed',
        'messaging.too_many_participants',
        `A ${type.toLowerCase()} may have at most ${MAX_PARTICIPANTS[type]} members.`,
        { maxParticipants: MAX_PARTICIPANTS[type] },
      ),
    );
  }

  const created = conversation(
    {
      id: input.id,
      type,
      title: title.value,
      createdBy: input.creator,
      createdAt: input.at,
      directPair: null,
    },
    roles.size,
  );
  return ok({
    conversation: created,
    participants: [...roles].map(([userId, role]) =>
      newParticipant(created, userId, role, input.creator, input.at),
    ),
  });
}
