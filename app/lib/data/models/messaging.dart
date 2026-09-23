import 'dart:typed_data';

import 'data_origin.dart';

/// Messaging, as the backend describes it (backend/src/modules/messaging/api).
///
/// Every enum has an `unknown` member so a value a newer server adds —
/// a VIDEO message, a MODERATOR role — degrades gracefully on an older app
/// instead of crashing it.

enum ConversationType {
  direct,
  group,
  channel,
  unknown;

  static ConversationType fromWire(String value) => switch (value) {
    'DIRECT' => direct,
    'GROUP' => group,
    'CHANNEL' => channel,
    _ => unknown,
  };
}

enum MessageType {
  text,
  voice,
  image,
  file,
  unknown;

  static MessageType fromWire(String value) => switch (value) {
    'TEXT' => text,
    'VOICE' => voice,
    'IMAGE' => image,
    'FILE' => file,
    _ => unknown,
  };
}

enum ParticipantRole {
  owner,
  publisher,
  member,
  unknown;

  static ParticipantRole fromWire(String value) => switch (value) {
    'OWNER' => owner,
    'PUBLISHER' => publisher,
    'MEMBER' => member,
    _ => unknown,
  };
}

/// What a stored file is — the server's `FileKind`.
enum AttachmentKind {
  image('IMAGE'),
  voice('VOICE'),
  audio('AUDIO'),
  document('DOCUMENT'),
  unknown('UNKNOWN');

  const AttachmentKind(this.wire);

  final String wire;

  static AttachmentKind fromWire(String? value) => switch (value) {
    'IMAGE' => image,
    'VOICE' => voice,
    'AUDIO' => audio,
    'DOCUMENT' => document,
    _ => unknown,
  };
}

/// A file on a message. [available] is false once the server no longer has
/// it; the other fields are then null.
class Attachment {
  const Attachment({
    required this.fileAssetId,
    required this.available,
    this.kind = AttachmentKind.unknown,
    this.contentType,
    this.byteSize,
    this.displayName,
    this.durationMs,
    this.width,
    this.height,
  });

  factory Attachment.fromJson(Map<String, Object?> json) => Attachment(
    fileAssetId: json['fileAssetId']! as String,
    available: json['available']! as bool,
    kind: AttachmentKind.fromWire(json['kind'] as String?),
    contentType: json['contentType'] as String?,
    byteSize: json['byteSize'] as int?,
    displayName: json['displayName'] as String?,
    durationMs: json['durationMs'] as int?,
    width: json['width'] as int?,
    height: json['height'] as int?,
  );

  final String fileAssetId;
  final bool available;
  final AttachmentKind kind;
  final String? contentType;
  final int? byteSize;
  final String? displayName;
  final int? durationMs;
  final int? width;
  final int? height;
}

class Message {
  const Message({
    required this.id,
    required this.conversationId,
    required this.sequence,
    required this.senderId,
    required this.type,
    required this.createdAt,
    this.body,
    this.replyToMessageId,
    this.clientMessageId,
    this.editedAt,
    this.deletedAt,
    this.attachments = const [],
  });

  factory Message.fromJson(Map<String, Object?> json) => Message(
    id: json['id']! as String,
    conversationId: json['conversationId']! as String,
    sequence: json['sequence']! as int,
    senderId: json['senderId']! as String,
    type: MessageType.fromWire(json['type']! as String),
    body: json['body'] as String?,
    replyToMessageId: json['replyToMessageId'] as String?,
    clientMessageId: json['clientMessageId'] as String?,
    createdAt: DateTime.parse(json['createdAt']! as String),
    editedAt: _date(json['editedAt']),
    deletedAt: _date(json['deletedAt']),
    attachments: [
      for (final item in json['attachments']! as List<Object?>)
        Attachment.fromJson((item! as Map).cast<String, Object?>()),
    ],
  );

  final String id;
  final String conversationId;

  /// The server's order — also the pagination cursor. Never a client clock.
  final int sequence;
  final String senderId;
  final MessageType type;
  final String? body;
  final String? replyToMessageId;

  /// Present only on the viewer's own messages.
  final String? clientMessageId;
  final DateTime createdAt;
  final DateTime? editedAt;
  final DateTime? deletedAt;
  final List<Attachment> attachments;

  bool get isDeleted => deletedAt != null;
}

class MessagePreview {
  const MessagePreview({
    required this.sequence,
    required this.senderId,
    required this.type,
    required this.deleted,
    required this.createdAt,
    this.senderName,
    this.text,
  });

  factory MessagePreview.fromJson(Map<String, Object?> json) => MessagePreview(
    sequence: json['sequence']! as int,
    senderId: json['senderId']! as String,
    senderName: json['senderName'] as String?,
    type: MessageType.fromWire(json['type']! as String),
    text: json['text'] as String?,
    deleted: json['deleted']! as bool,
    createdAt: DateTime.parse(json['createdAt']! as String),
  );

  final int sequence;
  final String senderId;
  final String? senderName;
  final MessageType type;
  final String? text;
  final bool deleted;
  final DateTime createdAt;
}

/// A conversation as the viewer sees it.
class Conversation implements Sourced {
  const Conversation({
    required this.id,
    required this.type,
    required this.memberCount,
    required this.myRole,
    required this.canPost,
    required this.canManageMembers,
    required this.lastSequence,
    required this.lastReadSequence,
    required this.unreadCount,
    required this.createdAt,
    required this.activityAt,
    this.title,
    this.counterpartUserId,
    this.lastMessage,
    this.origin = DataOrigin.profile,
  });

  factory Conversation.fromJson(Map<String, Object?> json) => Conversation(
    id: json['id']! as String,
    type: ConversationType.fromWire(json['type']! as String),
    title: json['title'] as String?,
    counterpartUserId: json['counterpartUserId'] as String?,
    memberCount: json['memberCount']! as int,
    myRole: ParticipantRole.fromWire(json['myRole']! as String),
    canPost: json['canPost']! as bool,
    canManageMembers: json['canManageMembers']! as bool,
    lastSequence: json['lastSequence']! as int,
    lastReadSequence: json['lastReadSequence']! as int,
    unreadCount: json['unreadCount']! as int,
    lastMessage: json['lastMessage'] == null
        ? null
        : MessagePreview.fromJson(
            (json['lastMessage']! as Map).cast<String, Object?>(),
          ),
    createdAt: DateTime.parse(json['createdAt']! as String),
    activityAt: DateTime.parse(json['activityAt']! as String),
  );

  final String id;
  final ConversationType type;

  /// A group's or channel's title; for a direct conversation, the other
  /// person's name. Null when the server has no name to show.
  final String? title;
  final String? counterpartUserId;
  final int memberCount;
  final ParticipantRole myRole;
  final bool canPost;
  final bool canManageMembers;
  final int lastSequence;
  final int lastReadSequence;

  /// Capped by the server; from [unreadCountCap] on, show "99+".
  final int unreadCount;
  final MessagePreview? lastMessage;
  final DateTime createdAt;
  final DateTime activityAt;

  @override
  final DataOrigin origin;

  static const int unreadCountCap = 100;

  Conversation withReadUpTo(int sequence) => Conversation(
    id: id,
    type: type,
    title: title,
    counterpartUserId: counterpartUserId,
    memberCount: memberCount,
    myRole: myRole,
    canPost: canPost,
    canManageMembers: canManageMembers,
    lastSequence: lastSequence,
    lastReadSequence: sequence > lastReadSequence ? sequence : lastReadSequence,
    unreadCount: sequence >= lastSequence ? 0 : unreadCount,
    lastMessage: lastMessage,
    createdAt: createdAt,
    activityAt: activityAt,
    origin: origin,
  );
}

class ConversationPage {
  const ConversationPage({required this.items, this.nextCursor});

  factory ConversationPage.fromJson(Map<String, Object?> json) =>
      ConversationPage(
        items: [
          for (final item in json['items']! as List<Object?>)
            Conversation.fromJson((item! as Map).cast<String, Object?>()),
        ],
        nextCursor: json['nextCursor'] as String?,
      );

  final List<Conversation> items;
  final String? nextCursor;
}

class MessagePage {
  const MessagePage({
    required this.items,
    required this.hasOlder,
    required this.hasNewer,
    required this.lastReadSequence,
    this.senderNames = const {},
  });

  factory MessagePage.fromJson(Map<String, Object?> json) => MessagePage(
    items: [
      for (final item in json['items']! as List<Object?>)
        Message.fromJson((item! as Map).cast<String, Object?>()),
    ],
    hasOlder: json['hasOlder']! as bool,
    hasNewer: json['hasNewer']! as bool,
    lastReadSequence: json['lastReadSequence']! as int,
    senderNames: {
      for (final sender in json['senders']! as List<Object?>)
        ((sender! as Map)['userId']! as String):
            (sender as Map)['displayName']! as String,
    },
  );

  /// Ascending by sequence.
  final List<Message> items;
  final bool hasOlder;
  final bool hasNewer;
  final int lastReadSequence;
  final Map<String, String> senderNames;
}

/// A file about to be sent: the bytes and what they claim to be. The server
/// verifies the claim — size and signature — before the file can be used.
class OutgoingFile {
  const OutgoingFile({
    required this.bytes,
    required this.fileName,
    required this.contentType,
    required this.kind,
    this.durationMs,
    this.width,
    this.height,
  });

  final Uint8List bytes;
  final String fileName;
  final String contentType;
  final AttachmentKind kind;
  final int? durationMs;
  final int? width;
  final int? height;
}

/// A refusal the messaging UI should explain, with the server's stable code
/// (`messaging.posting_not_allowed`, `files.too_large`, `network.unreachable`…).
class MessagingException implements Exception {
  const MessagingException(this.code, this.message);

  final String code;
  final String message;

  bool get isNetwork => code == 'network.unreachable';

  @override
  String toString() => 'MessagingException($code): $message';
}

DateTime? _date(Object? value) =>
    value == null ? null : DateTime.parse(value as String);
