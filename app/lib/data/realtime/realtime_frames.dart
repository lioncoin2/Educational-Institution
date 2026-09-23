import 'dart:convert';

import '../models/messaging.dart';
import '../models/notifications.dart';

/// The realtime wire protocol, version 1, as the app reads it
/// (backend/src/modules/realtime/domain/protocol.ts).
///
/// Every frame is checked before anything trusts it: a frame from a newer
/// server, a malformed one, or one whose fields disagree with each other is
/// dropped — never half-applied.
const int realtimeProtocolVersion = 1;

/// The server's stable error codes.
enum RealtimeErrorCode {
  unauthorized('UNAUTHORIZED'),
  forbidden('FORBIDDEN'),
  invalidEvent('INVALID_EVENT'),
  invalidPayload('INVALID_PAYLOAD'),
  conversationNotFound('CONVERSATION_NOT_FOUND'),
  notMember('NOT_MEMBER'),
  rateLimited('RATE_LIMITED'),
  serverError('SERVER_ERROR'),
  unknown('UNKNOWN');

  const RealtimeErrorCode(this.wire);

  final String wire;

  static RealtimeErrorCode fromWire(String? value) =>
      values.firstWhere((code) => code.wire == value, orElse: () => unknown);

  /// The conversation is not (or no longer) one this person may follow.
  bool get meansNoAccess => this == conversationNotFound || this == notMember;
}

/// Close codes the server uses (RFC 6455 §7.4.2 application range).
abstract final class RealtimeCloseCodes {
  static const int goingAway = 1001;
  static const int tryAgainLater = 1013;
  static const int unauthorized = 4401;
  static const int forbidden = 4403;
  static const int rateLimited = 4429;
}

/// Anything the server sends.
sealed class ServerFrame {
  const ServerFrame();

  /// The frame, or null for anything this version of the app must not act on.
  static ServerFrame? parse(String text) {
    try {
      final decoded = jsonDecode(text);
      if (decoded is! Map) return null;
      final json = decoded.cast<String, Object?>();
      if (json['version'] != realtimeProtocolVersion) return null;
      return switch (json['type']) {
        'ready' => ReadyFrame._fromJson(json),
        'subscribed' => SubscribedFrame._fromJson(json),
        'pong' => PongFrame(id: json['id'] as String?),
        'error' => ErrorFrame._fromJson(json),
        'conversation.created' => ConversationCreatedEvent._fromJson(json),
        'message.sent' => MessageSentEvent._fromJson(json),
        'message.read' => MessageReadEvent._fromJson(json),
        'participant.added' => ParticipantAddedEvent._fromJson(json),
        'participant.removed' => ParticipantRemovedEvent._fromJson(json),
        'notification.created' => NotificationCreatedEvent._fromJson(json),
        'notification.read' => NotificationReadEvent._fromJson(json),
        'notification.read_all' => NotificationsReadAllEvent._fromJson(json),
        _ => null,
      };
    } on FormatException {
      return null;
    } on TypeError {
      return null;
    }
  }
}

/// Authenticated (again): the server's word on who, and until when.
final class ReadyFrame extends ServerFrame {
  const ReadyFrame({
    required this.connectionId,
    required this.userId,
    required this.expiresAt,
    required this.heartbeatSeconds,
  });

  factory ReadyFrame._fromJson(Map<String, Object?> json) => ReadyFrame(
    connectionId: json['connectionId']! as String,
    userId: json['userId']! as String,
    expiresAt: DateTime.parse(json['expiresAt']! as String),
    heartbeatSeconds: json['heartbeatSeconds']! as int,
  );

  final String connectionId;
  final String userId;
  final DateTime expiresAt;
  final int heartbeatSeconds;
}

final class SubscribedFrame extends ServerFrame {
  const SubscribedFrame({
    required this.conversationId,
    required this.lastSequence,
    required this.lastReadSequence,
    this.id,
  });

  factory SubscribedFrame._fromJson(Map<String, Object?> json) =>
      SubscribedFrame(
        conversationId: json['conversationId']! as String,
        lastSequence: json['lastSequence']! as int,
        lastReadSequence: json['lastReadSequence']! as int,
        id: json['id'] as String?,
      );

  final String conversationId;
  final int lastSequence;
  final int lastReadSequence;
  final String? id;
}

final class PongFrame extends ServerFrame {
  const PongFrame({this.id});

  final String? id;
}

final class ErrorFrame extends ServerFrame {
  const ErrorFrame({
    required this.code,
    required this.message,
    this.id,
    this.conversationId,
    this.retryAfterSeconds,
  });

  factory ErrorFrame._fromJson(Map<String, Object?> json) => ErrorFrame(
    code: RealtimeErrorCode.fromWire(json['code'] as String?),
    message: json['message'] as String? ?? '',
    id: json['id'] as String?,
    conversationId: json['conversationId'] as String?,
    retryAfterSeconds: json['retryAfterSeconds'] as int?,
  );

  final RealtimeErrorCode code;
  final String message;
  final String? id;
  final String? conversationId;
  final int? retryAfterSeconds;
}

/// Something that happened, for the app's state to absorb.
sealed class RealtimeEvent extends ServerFrame {
  const RealtimeEvent({required this.eventId, required this.occurredAt});

  /// The same for every delivery of the same fact.
  final String eventId;
  final DateTime occurredAt;
}

/// Something that happened in one conversation.
sealed class ConversationEvent extends RealtimeEvent {
  const ConversationEvent({
    required super.eventId,
    required super.occurredAt,
    required this.conversationId,
  });

  final String conversationId;
}

/// A conversation the viewer is in was just created — shown before anything
/// has been said in it. No content: the list fetches what it needs.
final class ConversationCreatedEvent extends ConversationEvent {
  const ConversationCreatedEvent({
    required super.eventId,
    required super.occurredAt,
    required super.conversationId,
    required this.conversationType,
  });

  factory ConversationCreatedEvent._fromJson(Map<String, Object?> json) =>
      ConversationCreatedEvent(
        eventId: json['eventId']! as String,
        occurredAt: DateTime.parse(json['occurredAt']! as String),
        conversationId: json['conversationId']! as String,
        conversationType: ConversationType.fromWire(
          json['conversationType']! as String,
        ),
      );

  final ConversationType conversationType;
}

/// A new message — exactly as the HTTP timeline renders it.
final class MessageSentEvent extends ConversationEvent {
  const MessageSentEvent({
    required super.eventId,
    required super.occurredAt,
    required super.conversationId,
    required this.conversationType,
    required this.message,
    this.senderName,
  });

  /// Null when the envelope and the message it carries disagree.
  static MessageSentEvent? _fromJson(Map<String, Object?> json) {
    final conversationId = json['conversationId']! as String;
    final sequence = json['sequence']! as int;
    final message = Message.fromJson(
      (json['message']! as Map).cast<String, Object?>(),
    );
    if (message.conversationId != conversationId ||
        message.sequence != sequence ||
        message.id != json['messageId']) {
      return null;
    }
    final sender = (json['sender'] as Map?)?.cast<String, Object?>();
    return MessageSentEvent(
      eventId: json['eventId']! as String,
      occurredAt: DateTime.parse(json['occurredAt']! as String),
      conversationId: conversationId,
      conversationType: ConversationType.fromWire(
        json['conversationType']! as String,
      ),
      message: message,
      senderName: sender?['displayName'] as String?,
    );
  }

  final ConversationType conversationType;
  final Message message;
  final String? senderName;

  int get sequence => message.sequence;
}

/// Someone's read mark moved — in V1, only ever the viewer's own, from
/// another of their devices.
final class MessageReadEvent extends ConversationEvent {
  const MessageReadEvent({
    required super.eventId,
    required super.occurredAt,
    required super.conversationId,
    required this.userId,
    required this.lastReadSequence,
  });

  factory MessageReadEvent._fromJson(Map<String, Object?> json) =>
      MessageReadEvent(
        eventId: json['eventId']! as String,
        occurredAt: DateTime.parse(json['occurredAt']! as String),
        conversationId: json['conversationId']! as String,
        userId: json['userId']! as String,
        lastReadSequence: json['lastReadSequence']! as int,
      );

  final String userId;
  final int lastReadSequence;
}

final class ParticipantAddedEvent extends ConversationEvent {
  const ParticipantAddedEvent({
    required super.eventId,
    required super.occurredAt,
    required super.conversationId,
    required this.userId,
    required this.role,
  });

  factory ParticipantAddedEvent._fromJson(Map<String, Object?> json) =>
      ParticipantAddedEvent(
        eventId: json['eventId']! as String,
        occurredAt: DateTime.parse(json['occurredAt']! as String),
        conversationId: json['conversationId']! as String,
        userId: json['userId']! as String,
        role: ParticipantRole.fromWire(json['role']! as String),
      );

  final String userId;
  final ParticipantRole role;
}

final class ParticipantRemovedEvent extends ConversationEvent {
  const ParticipantRemovedEvent({
    required super.eventId,
    required super.occurredAt,
    required super.conversationId,
    required this.userId,
    required this.reason,
  });

  factory ParticipantRemovedEvent._fromJson(Map<String, Object?> json) =>
      ParticipantRemovedEvent(
        eventId: json['eventId']! as String,
        occurredAt: DateTime.parse(json['occurredAt']! as String),
        conversationId: json['conversationId']! as String,
        userId: json['userId']! as String,
        reason: json['reason']! as String,
      );

  final String userId;

  /// `left`, `removed` or `moderated`.
  final String reason;
}

/// Something that happened in the viewer's own notification inbox. Only ever
/// the viewer's: the server sends a notification to its recipient alone.
sealed class NotificationEvent extends RealtimeEvent {
  const NotificationEvent({required super.eventId, required super.occurredAt});
}

/// A new notification — exactly as the HTTP inbox renders it.
final class NotificationCreatedEvent extends NotificationEvent {
  const NotificationCreatedEvent({
    required super.eventId,
    required super.occurredAt,
    required this.notification,
  });

  factory NotificationCreatedEvent._fromJson(Map<String, Object?> json) =>
      NotificationCreatedEvent(
        eventId: json['eventId']! as String,
        occurredAt: DateTime.parse(json['occurredAt']! as String),
        notification: AppNotification.fromJson(
          (json['notification']! as Map).cast<String, Object?>(),
        ),
      );

  final AppNotification notification;
}

/// One notification was read — on another of the viewer's devices.
final class NotificationReadEvent extends NotificationEvent {
  const NotificationReadEvent({
    required super.eventId,
    required super.occurredAt,
    required this.notificationId,
    required this.readAt,
  });

  factory NotificationReadEvent._fromJson(Map<String, Object?> json) =>
      NotificationReadEvent(
        eventId: json['eventId']! as String,
        occurredAt: DateTime.parse(json['occurredAt']! as String),
        notificationId: json['notificationId']! as String,
        readAt: DateTime.parse(json['readAt']! as String),
      );

  final String notificationId;
  final DateTime readAt;
}

/// Everything up to a point was marked read — on another of the viewer's
/// devices: every notification created before [throughCreatedAt], and those
/// created at it with an id up to [throughId] (all of them when null).
final class NotificationsReadAllEvent extends NotificationEvent {
  const NotificationsReadAllEvent({
    required super.eventId,
    required super.occurredAt,
    required this.throughCreatedAt,
    required this.readAt,
    this.throughId,
  });

  factory NotificationsReadAllEvent._fromJson(Map<String, Object?> json) =>
      NotificationsReadAllEvent(
        eventId: json['eventId']! as String,
        occurredAt: DateTime.parse(json['occurredAt']! as String),
        throughCreatedAt: DateTime.parse(json['throughCreatedAt']! as String),
        throughId: json['throughId'] as String?,
        readAt: DateTime.parse(json['readAt']! as String),
      );

  final DateTime throughCreatedAt;
  final String? throughId;
  final DateTime readAt;
}
