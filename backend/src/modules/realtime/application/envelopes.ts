import { createHash } from 'node:crypto';

import type { MessageView, PersonView } from '../../messaging/contracts/message-view';
import type { ConversationPosition } from '../../messaging/contracts/message-delivery';
import type { ConversationType, ParticipantRole } from '../../messaging/contracts/vocabulary';
import type { NotificationView } from '../../notifications/contracts/notification-reader';
import { PROTOCOL_VERSION, type RealtimeErrorCode } from '../domain/protocol';

/**
 * Server → client frames, version 1. Every one is built here, field by field,
 * from messaging's and notifications' contract views, Communities' events and
 * the event's identifiers — never by spreading a domain event or a stored row
 * onto the wire, so nothing the contract does not name (an audit field, a
 * storage key, a signed URL, a token, a deduplication key) can reach a client
 * by accident.
 *
 * Each builder returns the serialized frame: an event is serialized once and
 * the same string is sent to every connection that receives it.
 */

/** A message exactly as the HTTP API renders one (`MessageResponse`). */
interface WireMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly senderId: string;
  readonly type: string;
  readonly body: string | null;
  readonly replyToMessageId: string | null;
  readonly clientMessageId: string | null;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
  readonly attachments: readonly {
    readonly fileAssetId: string;
    readonly available: boolean;
    readonly kind: string | null;
    readonly contentType: string | null;
    readonly byteSize: number | null;
    readonly displayName: string | null;
    readonly durationMs: number | null;
    readonly width: number | null;
    readonly height: number | null;
  }[];
}

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

function wireMessage(message: MessageView): WireMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    sequence: message.sequence,
    senderId: message.senderId,
    type: message.type,
    body: message.body,
    replyToMessageId: message.replyToMessageId,
    clientMessageId: message.clientMessageId,
    createdAt: message.createdAt.toISOString(),
    editedAt: iso(message.editedAt),
    deletedAt: iso(message.deletedAt),
    attachments: message.attachments.map((attachment) => {
      const file = attachment.file;
      return {
        fileAssetId: attachment.fileAssetId,
        available: file !== null,
        kind: file?.kind ?? null,
        contentType: file?.contentType ?? null,
        byteSize: file?.byteSize ?? null,
        displayName: file?.displayName ?? null,
        durationMs: file?.durationMs ?? null,
        width: file?.width ?? null,
        height: file?.height ?? null,
      };
    }),
  };
}

const frame = (body: Record<string, unknown>): string =>
  JSON.stringify({ ...body, version: PROTOCOL_VERSION });

const withId = (id: string | undefined) => (id === undefined ? {} : { id });

// ── Replies ────────────────────────────────────────────────────────────────

export function readyFrame(input: {
  readonly connectionId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly heartbeatSeconds: number;
  readonly id?: string;
}): string {
  return frame({
    type: 'ready',
    connectionId: input.connectionId,
    userId: input.userId,
    expiresAt: input.expiresAt.toISOString(),
    heartbeatSeconds: input.heartbeatSeconds,
    ...withId(input.id),
  });
}

export function subscribedFrame(position: ConversationPosition, id?: string): string {
  return frame({
    type: 'subscribed',
    conversationId: position.conversationId,
    lastSequence: position.lastSequence,
    lastReadSequence: position.lastReadSequence,
    ...withId(id),
  });
}

export function pongFrame(id?: string): string {
  return frame({ type: 'pong', ...withId(id) });
}

export function errorFrame(
  code: RealtimeErrorCode,
  message: string,
  extra: {
    readonly id?: string;
    readonly conversationId?: string;
    retryAfterSeconds?: number;
  } = {},
): string {
  return frame({
    type: 'error',
    code,
    message,
    ...withId(extra.id),
    ...(extra.conversationId === undefined ? {} : { conversationId: extra.conversationId }),
    ...(extra.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: extra.retryAfterSeconds }),
  });
}

// ── Events ─────────────────────────────────────────────────────────────────
//
// `eventId` is derived from the fact itself, not generated: the same fact
// delivered twice — by a retrying outbox one day — carries the same id, so a
// client can drop the second copy by id alone.

export function messageSentFrame(input: {
  readonly occurredAt: Date;
  readonly conversationType: ConversationType;
  readonly message: MessageView;
  readonly sender: PersonView | null;
}): string {
  const message = input.message;
  return frame({
    type: 'message.sent',
    eventId: `message.sent:${message.id}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: message.conversationId,
    conversationType: input.conversationType,
    messageId: message.id,
    sequence: message.sequence,
    message: wireMessage(message),
    sender:
      input.sender === null
        ? { userId: message.senderId, displayName: null }
        : { userId: input.sender.userId, displayName: input.sender.displayName },
  });
}

export function conversationCreatedFrame(input: {
  readonly occurredAt: Date;
  readonly conversationId: string;
  readonly conversationType: ConversationType;
}): string {
  return frame({
    type: 'conversation.created',
    eventId: `conversation.created:${input.conversationId}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: input.conversationId,
    conversationType: input.conversationType,
  });
}

export function messageReadFrame(input: {
  readonly occurredAt: Date;
  readonly conversationId: string;
  readonly userId: string;
  readonly lastReadSequence: number;
}): string {
  return frame({
    type: 'message.read',
    eventId: `message.read:${input.conversationId}:${input.userId}:${input.lastReadSequence}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: input.conversationId,
    userId: input.userId,
    lastReadSequence: input.lastReadSequence,
  });
}

export function participantAddedFrame(input: {
  readonly occurredAt: Date;
  readonly conversationId: string;
  readonly userId: string;
  readonly role: ParticipantRole;
}): string {
  return frame({
    type: 'participant.added',
    eventId: `participant.added:${input.conversationId}:${input.userId}:${input.occurredAt.getTime()}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: input.conversationId,
    userId: input.userId,
    role: input.role,
  });
}

export function participantRemovedFrame(input: {
  readonly occurredAt: Date;
  readonly conversationId: string;
  readonly userId: string;
  readonly reason: 'left' | 'removed' | 'moderated';
}): string {
  return frame({
    type: 'participant.removed',
    eventId: `participant.removed:${input.conversationId}:${input.userId}:${input.occurredAt.getTime()}`,
    occurredAt: input.occurredAt.toISOString(),
    conversationId: input.conversationId,
    userId: input.userId,
    reason: input.reason,
  });
}

// ── Notifications ──────────────────────────────────────────────────────────
//
// A notification exactly as the HTTP inbox renders one (`NotificationResponse`
// in the notifications module): the recipient's own, so it carries no
// recipient id.

function wireNotification(view: NotificationView): Record<string, unknown> {
  return {
    id: view.id,
    type: view.type,
    category: view.category,
    titleKey: view.titleKey,
    bodyKey: view.bodyKey,
    params: { ...view.params },
    target: { ...view.target },
    createdAt: view.createdAt.toISOString(),
    readAt: iso(view.readAt),
  };
}

export function notificationCreatedFrame(view: NotificationView): string {
  return frame({
    type: 'notification.created',
    eventId: `notification.created:${view.id}`,
    occurredAt: view.createdAt.toISOString(),
    notification: wireNotification(view),
  });
}

export function notificationReadFrame(input: {
  readonly notificationId: string;
  readonly readAt: string;
}): string {
  return frame({
    type: 'notification.read',
    eventId: `notification.read:${input.notificationId}`,
    occurredAt: input.readAt,
    notificationId: input.notificationId,
    readAt: input.readAt,
  });
}

export function notificationsReadFrame(input: {
  readonly throughCreatedAt: string;
  readonly throughId: string | null;
  readonly readAt: string;
}): string {
  return frame({
    type: 'notification.read_all',
    eventId: `notification.read_all:${input.throughCreatedAt}:${input.throughId ?? '*'}:${input.readAt}`,
    occurredAt: input.readAt,
    throughCreatedAt: input.throughCreatedAt,
    throughId: input.throughId,
    readAt: input.readAt,
  });
}

// ── Communities ────────────────────────────────────────────────────────────
//
// Hints, never grants (communities-live-attendance.md §16.2): ids, codes and
// versions only — no title, no name, no capability, no grant or invitation
// id, no count, no roster, and nothing of how someone joined or who acted.
// The client re-reads the community over HTTP, which decides everything.
// Golden copies of each: test/fixtures/realtime-frames/, shared with the app.

/**
 * "You are a member of this community now." The stint's membership version
 * is in the id only: stable across redelivery, and never a field — it is not
 * a version the client can compare against anything HTTP returns.
 */
export function communityMemberAddedFrame(input: {
  readonly occurredAt: Date;
  readonly communityId: string;
  readonly userId: string;
  readonly membershipVersion: number;
}): string {
  return frame({
    type: 'community.member.added',
    eventId: `community.member.added:${input.communityId}:${input.userId}:${input.membershipVersion}`,
    occurredAt: input.occurredAt.toISOString(),
    communityId: input.communityId,
    userId: input.userId,
  });
}

/** "You are no longer a member": you left, or were removed. Nothing else is said. */
export function communityMemberRemovedFrame(input: {
  readonly occurredAt: Date;
  readonly communityId: string;
  readonly userId: string;
  readonly reason: 'left' | 'removed';
  readonly membershipVersion: number;
}): string {
  return frame({
    type: 'community.member.removed',
    eventId: `community.member.removed:${input.communityId}:${input.userId}:${input.membershipVersion}`,
    occurredAt: input.occurredAt.toISOString(),
    communityId: input.communityId,
    userId: input.userId,
    reason: input.reason,
  });
}

/**
 * The community was locked, as of `lifecycleVersion` — which the client
 * compares with the one `GET /communities/:id` returned, so a frame older
 * than what it holds is dropped and a newer one triggers the re-read.
 */
export function communityLockedFrame(input: {
  readonly occurredAt: Date;
  readonly communityId: string;
  readonly lifecycleVersion: number;
}): string {
  return frame({
    type: 'community.locked',
    eventId: `community.locked:${input.communityId}:${input.lifecycleVersion}`,
    occurredAt: input.occurredAt.toISOString(),
    communityId: input.communityId,
    lifecycleVersion: input.lifecycleVersion,
  });
}

export function communityUnlockedFrame(input: {
  readonly occurredAt: Date;
  readonly communityId: string;
  readonly lifecycleVersion: number;
}): string {
  return frame({
    type: 'community.unlocked',
    eventId: `community.unlocked:${input.communityId}:${input.lifecycleVersion}`,
    occurredAt: input.occurredAt.toISOString(),
    communityId: input.communityId,
    lifecycleVersion: input.lifecycleVersion,
  });
}

/**
 * What changed someone's access: a grant made or revoked — named by the grant,
 * which its holder can already list — or ownership moved, named by which side
 * of it the recipient is on and when. Never by the other party: a former owner
 * may no longer read who owns the community now, and a digest of a guessable
 * name would tell them.
 */
export type AccessChangeCause =
  | { readonly kind: 'granted' | 'revoked'; readonly grantId: string }
  | { readonly kind: 'transferred'; readonly side: 'from' | 'to' };

/**
 * "What you may do here changed" — a capability granted or revoked, or
 * ownership moved. Which, and by whom, stays off the wire: the client
 * re-reads its `me` block. The recipient is in the id because one fact (a
 * transfer) tells two people, each with their own frame. The cause is in it
 * too, so that two changes are never one id — a client drops a repeated id,
 * and a second change dropped as a duplicate of the first would be a re-read
 * that never happens — but only as a digest: the id names the fact without
 * naming the grant, the capability or the other party.
 */
export function communityAccessChangedFrame(input: {
  readonly occurredAt: Date;
  readonly communityId: string;
  readonly userId: string;
  readonly cause: AccessChangeCause;
}): string {
  const cause =
    input.cause.kind === 'transferred'
      ? `transferred:${input.cause.side}:${input.occurredAt.getTime()}`
      : `${input.cause.kind}:${input.cause.grantId}`;
  return frame({
    type: 'community.access.changed',
    eventId: `community.access.changed:${input.communityId}:${input.userId}:${digest(cause)}`,
    occurredAt: input.occurredAt.toISOString(),
    communityId: input.communityId,
  });
}

/**
 * A fixed-length name for a fact: the same fact, the same name. One-way only
 * for what the recipient cannot guess — so a fact names nothing they may not
 * already know.
 */
function digest(fact: string): string {
  return createHash('sha256').update(fact).digest('hex').slice(0, 20);
}
