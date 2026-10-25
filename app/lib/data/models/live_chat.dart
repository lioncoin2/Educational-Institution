/// A live session's own chat (ADR 0047) — the session's, never the
/// community's conversation. Every value is the server's.
class LiveChatMessage {
  const LiveChatMessage({
    required this.id,
    required this.sessionId,
    required this.senderId,
    required this.senderDisplayName,
    required this.body,
    required this.createdAt,
    required this.position,
  });

  factory LiveChatMessage.fromJson(Map<String, Object?> json) =>
      LiveChatMessage(
        id: json['id']! as String,
        sessionId: json['sessionId']! as String,
        senderId: json['senderId']! as String,
        senderDisplayName: json['senderDisplayName'] as String? ?? '',
        body: json['body']! as String,
        createdAt: DateTime.parse(json['createdAt']! as String),
        position: json['position']! as int,
      );

  final String id;
  final String sessionId;
  final String senderId;

  /// '' when the account has no name now.
  final String senderDisplayName;

  /// Plain text; line breaks kept.
  final String body;
  final DateTime createdAt;

  /// The session's chat order — increasing; the page cursor.
  final int position;
}

/// A page of a session's chat, newest first, and where the chat stands for
/// the viewer as the server decided it on this read.
class LiveChatPage {
  const LiveChatPage({
    required this.items,
    required this.nextCursor,
    required this.locked,
    required this.lockVersion,
    required this.canPost,
    required this.canModerate,
  });

  factory LiveChatPage.fromJson(Map<String, Object?> json) => LiveChatPage(
    items: [
      for (final item in json['items']! as List<Object?>)
        LiveChatMessage.fromJson((item! as Map).cast<String, Object?>()),
    ],
    nextCursor: json['nextCursor'] as String?,
    locked: json['locked'] == true,
    lockVersion: json['lockVersion'] as int? ?? 0,
    canPost: json['canPost'] == true,
    canModerate: json['canModerate'] == true,
  );

  final List<LiveChatMessage> items;
  final String? nextCursor;

  /// A moderator has closed the chat to participants; moderators still post.
  final bool locked;
  final int lockVersion;

  /// The viewer may post now (the session live, the chat open or theirs to moderate).
  final bool canPost;

  /// The viewer may lock and re-open it.
  final bool canModerate;
}

/// The chat's switch after a moderator's lock or re-open.
class LiveChatLockState {
  const LiveChatLockState({required this.locked, required this.lockVersion});

  factory LiveChatLockState.fromJson(Map<String, Object?> json) =>
      LiveChatLockState(
        locked: json['locked'] == true,
        lockVersion: json['lockVersion'] as int? ?? 0,
      );

  final bool locked;
  final int lockVersion;
}
