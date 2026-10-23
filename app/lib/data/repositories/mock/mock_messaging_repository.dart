import '../../../app/app_config.dart';
import '../../models/communities.dart' show CommunityKind;
import '../../models/data_origin.dart';
import '../../models/messaging.dart';
import '../../models/publication.dart';
import '../repositories.dart';
import 'mock_community_repository.dart';

/// In-memory stand-in for the messaging backend, for the demo build and for
/// widget tests.
///
/// It keeps the server's rules, so screens built against it behave the same
/// against the real API: the server orders messages by sequence; a retried
/// clientMessageId returns the original; pages are keyed by sequence; unread
/// counts stop at the cap; the read watermark only moves forward; channels
/// refuse posts from readers. Everything in it is invented and marked as such.
///
/// Each community of `MockCommunityRepository` has its chat here, as on the
/// server: a CHANNEL carrying the community's id, listed with the others and
/// resolved from the community by [conversationForCommunity]. Whether the
/// viewer reads it, and may post in it, is the community's to say: running
/// beside the demo's communities, this mock asks them ([mayReadIn],
/// [mayPostIn]) as the server's messaging asks its communities; on its own,
/// the chats stand as seeded — one for each community the viewer starts in,
/// and posting open in the one they own.
class MockMessagingRepository implements MessagingRepository {
  MockMessagingRepository({
    this.latency = AppConfig.fakeLatency,
    this.mayReadIn,
    this.mayPostIn,
  }) {
    _seed();
  }

  final Duration latency;

  /// Whether the viewer reads community [communityId]'s chat now: its `me`
  /// takes part in `community.chat.read`. A chat not theirs to read is, to
  /// them, one that does not exist.
  final bool Function(String communityId)? mayReadIn;

  /// Whether the viewer may post in community [communityId]'s chat now: its
  /// `me` holds `community.chat.post`.
  final bool Function(String communityId)? mayPostIn;

  static const String viewer = 'mock-student';
  static const String _teacher = 'mock-teacher';
  static const String _admin = 'mock-admin';

  /// Who the viewer (a student) may start a direct conversation with (Q6): the
  /// demo's other students (`messaging.start_direct_peer`) and the eligible
  /// teacher (`messaging.start_direct_teacher`). The admin (`_admin`) and
  /// unknown ids are absent, so the mock refuses them exactly as the server
  /// does. Names match the demo people repository.
  static const Map<String, String> _reachable = {
    'mock-peer-1': 'أحمد',
    'mock-peer-2': 'يوسف',
    'mock-person-sara': 'سارة',
    'mock-person-salma': 'سلمى',
    'mock-teacher': 'الأستاذ عبدالله', // an eligible teacher
  };

  final Map<String, _MockConversation> _conversations = {};

  static final DateTime _start = DateTime.utc(2026, 9, 1, 5, 30);

  @override
  Future<String> viewerId() async => viewer;

  @override
  Future<ConversationPage> conversations({String? cursor}) async {
    await _wait();
    final all = _conversations.values.where(_readable).toList()
      ..sort((a, b) => b.activityAt.compareTo(a.activityAt));
    return ConversationPage(items: [for (final c in all) _view(c)]);
  }

  @override
  Future<Conversation> conversation(String conversationId) async {
    await _wait();
    return _view(_find(conversationId));
  }

  @override
  Future<Conversation> conversationForCommunity(String communityId) async {
    await _wait();
    final chat = _conversations.values
        .where((c) => c.communityId == communityId)
        .firstOrNull;
    if (chat == null || !_readable(chat)) {
      // An unknown community and one that is not the viewer's are answered
      // alike.
      throw const MessagingException(
        'messaging.conversation_not_found',
        'No such conversation.',
      );
    }
    return _view(chat);
  }

  @override
  Future<Conversation> startDirect(String userId) async {
    await _wait();
    if (userId == viewer) {
      throw const MessagingException(
        'messaging.direct_with_self',
        'A direct conversation needs two people.',
      );
    }
    // The demo viewer is a student: they reach another student or an eligible
    // teacher, never an administrator. An admin and an unknown id are refused
    // alike — the server is the boundary (start_direct_peer / _teacher), and the
    // app cannot probe for who is who.
    final name = _reachable[userId];
    if (name == null) {
      throw const MessagingException(
        'messaging.participant_not_eligible',
        'Some of these people cannot take part in conversations.',
      );
    }
    // Canonical: the same pair always yields the one conversation.
    final existing = _conversations.values
        .where(
          (c) =>
              c.type == ConversationType.direct && c.counterpartUserId == userId,
        )
        .firstOrNull;
    if (existing != null) return _view(existing);
    final created = _MockConversation(
      id: 'mock-direct-$userId',
      type: ConversationType.direct,
      title: name,
      counterpartUserId: userId,
      memberCount: 2,
      myRole: ParticipantRole.member,
      canPost: true,
      createdAt: DateTime.now().toUtc(),
      names: {userId: name, viewer: 'طالب تجريبي'},
    );
    _conversations[created.id] = created;
    return _view(created);
  }

  @override
  Future<MessagePage> messages(
    String conversationId, {
    int? before,
    int? after,
    int limit = 30,
  }) async {
    await _wait();
    final c = _find(conversationId);
    final all = c.messages;
    final List<Message> items;
    final bool hasOlder;
    final bool hasNewer;
    if (after != null) {
      final newer = all.where((m) => m.sequence > after).toList();
      items = newer.take(limit).toList();
      hasNewer = newer.length > limit;
      hasOlder = after > 0 && all.isNotEmpty;
    } else {
      final upper = before ?? c.lastSequence + 1;
      final older = all.where((m) => m.sequence < upper).toList();
      items = older
          .skip(older.length > limit ? older.length - limit : 0)
          .toList();
      hasOlder = older.length > limit;
      hasNewer = upper <= c.lastSequence;
    }
    return MessagePage(
      items: items,
      hasOlder: hasOlder,
      hasNewer: hasNewer,
      lastReadSequence: c.lastRead,
      senderNames: c.names,
    );
  }

  @override
  Future<Message> sendText(
    String conversationId, {
    required String clientMessageId,
    required String body,
    String? replyToMessageId,
  }) async {
    await _wait();
    final text = body.trim();
    if (text.isEmpty) {
      throw const MessagingException(
        'messaging.body_required',
        'A text message needs text.',
      );
    }
    return _append(
      conversationId,
      clientMessageId,
      MessageType.text,
      text,
      const [],
      replyToMessageId: replyToMessageId,
    );
  }

  @override
  Future<Message> sendVoice(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile recording,
    String? replyToMessageId,
  }) => _media(
    conversationId,
    clientMessageId,
    MessageType.voice,
    recording,
    null,
    replyToMessageId,
  );

  @override
  Future<Message> sendImage(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile image,
    String? caption,
    String? replyToMessageId,
  }) => _media(
    conversationId,
    clientMessageId,
    MessageType.image,
    image,
    caption,
    replyToMessageId,
  );

  @override
  Future<Message> sendFile(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile file,
    String? caption,
    String? replyToMessageId,
  }) => _media(
    conversationId,
    clientMessageId,
    MessageType.file,
    file,
    caption,
    replyToMessageId,
  );

  @override
  Future<int> markRead(String conversationId, int sequence) async {
    await _wait();
    final c = _find(conversationId);
    final target = sequence < c.lastSequence ? sequence : c.lastSequence;
    if (target > c.lastRead) c.lastRead = target;
    return c.lastRead;
  }

  @override
  Future<PublicationReport> publishToCommunities({
    required String clientBatchId,
    required List<String> communityIds,
    required String kind,
    String? body,
    String? fileAssetId,
  }) async {
    await _wait();
    // The demo authorizes each community exactly as the real server would — by
    // asking whether the viewer may post there — so the partial-failure and
    // retry UX is exercised without a backend. Idempotency is not modelled: the
    // demo always answers "posted" for a community the viewer may post in.
    final results = [
      for (final id in communityIds)
        if (mayPostIn?.call(id) ?? true)
          PublicationOutcome(
            communityId: id,
            status: PublicationStatus.posted,
            retryable: false,
            messageId: 'demo-$clientBatchId-$id',
          )
        else
          PublicationOutcome(
            communityId: id,
            status: PublicationStatus.forbidden,
            retryable: false,
          ),
    ];
    return PublicationReport(
      batchId: clientBatchId,
      results: results,
      origin: DataOrigin.mock,
    );
  }

  @override
  Future<Uri> attachmentUrl(
    String conversationId,
    String messageId,
    String fileAssetId,
  ) async {
    await _wait();
    throw const MessagingException(
      'messaging.attachment_unavailable',
      'Files are not stored in the demo.',
    );
  }

  @override
  Future<Uri> senderAvatarUrl(String conversationId, String messageId) async {
    await _wait();
    // No pictures in the demo: every sender shows initials, as on the server
    // for a sender who set none.
    throw const MessagingException(
      'messaging.sender_avatar_not_found',
      'Pictures are not stored in the demo.',
    );
  }

  @override
  Future<void> deleteMessage(String conversationId, String messageId) async {
    await _wait();
    final c = _find(conversationId);
    // Moderation is a community-chat operation only; a direct or group message
    // is the 404 a non-member hears, as on the server (ADR 0029).
    if (c.communityId == null) throw _notFound;
    final index = c.messages.indexWhere((m) => m.id == messageId);
    if (index < 0) {
      throw const MessagingException(
        'messaging.message_not_found',
        'No such message.',
      );
    }
    final current = c.messages[index];
    if (current.isDeleted) return; // idempotent: already a tombstone
    final at = DateTime.now().toUtc();
    c.deleted[messageId] = _DeletedOriginal(current, viewer, at);
    c.messages[index] = current.asTombstone(at);
  }

  @override
  Future<void> pinMessage(String conversationId, String messageId) async {
    await _wait();
    final c = _find(conversationId);
    // A community-chat act only, as on the server (ADR 0043).
    if (c.communityId == null) throw _notFound;
    final message = c.messages.where((m) => m.id == messageId).firstOrNull;
    if (message == null || message.isDeleted) {
      throw const MessagingException(
        'messaging.message_not_found',
        'No such message.',
      );
    }
    if (c.pinnedMessageId == messageId) return; // idempotent no-op; no version bump
    c.pinnedMessageId = messageId; // replaces any current pin (most-recent wins)
    c.pinVersion += 1;
  }

  @override
  Future<void> unpinMessage(String conversationId) async {
    await _wait();
    final c = _find(conversationId);
    if (c.communityId == null) throw _notFound;
    if (c.pinnedMessageId == null) return; // idempotent no-op; no version bump
    c.pinnedMessageId = null; // never deletes the message
    c.pinVersion += 1;
  }

  @override
  Future<ReviewedMessage> reviewDeletedMessage(
    String conversationId,
    String messageId,
  ) async {
    await _wait();
    final c = _find(conversationId);
    final record = c.deleted[messageId];
    if (record == null) {
      throw const MessagingException(
        'messaging.deleted_message_not_found',
        'No such deleted message.',
      );
    }
    final original = record.original;
    return ReviewedMessage(
      id: original.id,
      conversationId: original.conversationId,
      sequence: original.sequence,
      senderId: original.senderId,
      senderName: c.names[original.senderId],
      type: original.type,
      body: original.body,
      replyToMessageId: original.replyToMessageId,
      createdAt: original.createdAt,
      editedAt: original.editedAt,
      deletedAt: record.at,
      deletedBy: record.by,
      deletedByName: c.names[record.by],
      attachments: original.attachments,
    );
  }

  Future<Message> _media(
    String conversationId,
    String clientMessageId,
    MessageType type,
    OutgoingFile file,
    String? caption,
    String? replyToMessageId,
  ) async {
    await _wait();
    final attachment = Attachment(
      fileAssetId: 'mock-asset-$clientMessageId',
      available: true,
      kind: file.kind,
      contentType: file.contentType,
      byteSize: file.bytes.length,
      displayName: file.fileName,
      durationMs: file.durationMs,
      width: file.width,
      height: file.height,
    );
    final text = caption?.trim();
    return _append(
      conversationId,
      clientMessageId,
      type,
      text == null || text.isEmpty ? null : text,
      [attachment],
      replyToMessageId: replyToMessageId,
    );
  }

  Message _append(
    String conversationId,
    String clientMessageId,
    MessageType type,
    String? body,
    List<Attachment> attachments, {
    String? replyToMessageId,
  }) {
    // The server validates the key first (domain/message.ts), before the
    // posting and reply checks — so an unusable key fails the same way here.
    if (!_clientMessageIdShape.hasMatch(clientMessageId)) {
      throw const MessagingException(
        'messaging.client_message_id_invalid',
        'clientMessageId must be 8–64 characters of letters, digits, "-" or "_".',
      );
    }
    final c = _find(conversationId);
    if (!_canPost(c)) {
      throw const MessagingException(
        'messaging.posting_not_allowed',
        'Only the owner and publishers may post in this channel.',
      );
    }
    // A reply target must be a message of THIS conversation (a tombstone still
    // counts — replying to a deleted message stays allowed, as on the server);
    // another conversation's id, or an unknown one, is "not found" so a reply
    // never becomes a way to learn a message exists (send-message.use-cases.ts
    // checkReply). The mock's viewer sees every message of a chat it reads, so
    // conversation membership is the visibility rule it can mirror.
    if (replyToMessageId != null &&
        !c.messages.any((m) => m.id == replyToMessageId)) {
      throw const MessagingException(
        'messaging.reply_target_not_found',
        'The message being replied to is not in this conversation.',
      );
    }
    final existing = c.byClientId[clientMessageId];
    if (existing != null) {
      if (_sameContent(existing, type, body, replyToMessageId, attachments)) {
        return existing;
      }
      throw const MessagingException(
        'messaging.client_message_id_reused',
        'This clientMessageId was already used for a different message.',
      );
    }
    final message = c.add(
      senderId: viewer,
      type: type,
      body: body,
      at: DateTime.now().toUtc(),
      clientMessageId: clientMessageId,
      replyToMessageId: replyToMessageId,
      attachments: attachments,
    );
    c.lastRead = message.sequence; // writing means having read up to here
    return message;
  }

  /// Someone else's message reaching the pretend server — what a live
  /// connection would then announce. For tests and demonstrations.
  Message receive(
    String conversationId, {
    required String senderId,
    required String body,
  }) => _stored(conversationId).add(
    senderId: senderId,
    type: MessageType.text,
    body: body,
    at: DateTime.now().toUtc(),
  );

  /// The conversation as the viewer may reach it: a community chat they do
  /// not read is not found, like one that does not exist.
  _MockConversation _find(String id) {
    final c = _stored(id);
    if (!_readable(c)) throw _notFound;
    return c;
  }

  _MockConversation _stored(String id) =>
      _conversations[id] ?? (throw _notFound);

  static const _notFound = MessagingException(
    'messaging.conversation_not_found',
    'No such conversation.',
  );

  /// The backend's `CLIENT_MESSAGE_ID_SHAPE` (domain/message.ts): 8–64
  /// characters of letters, digits, "-" or "_".
  static final RegExp _clientMessageIdShape = RegExp(r'^[A-Za-z0-9_-]{8,64}$');

  /// Whether a retried send carries the SAME message as the one already stored
  /// under its key — the server's `sameContent` (domain/message.ts): type,
  /// body, reply target AND attachment identity (by `fileAssetId`, in order)
  /// must all match. Anything else reusing the key is a conflict, never a
  /// silent collapse of two distinct messages.
  static bool _sameContent(
    Message existing,
    MessageType type,
    String? body,
    String? replyToMessageId,
    List<Attachment> attachments,
  ) {
    if (existing.type != type ||
        existing.body != body ||
        existing.replyToMessageId != replyToMessageId ||
        existing.attachments.length != attachments.length) {
      return false;
    }
    for (var i = 0; i < attachments.length; i++) {
      if (existing.attachments[i].fileAssetId != attachments[i].fileAssetId) {
        return false;
      }
    }
    return true;
  }

  bool _readable(_MockConversation c) {
    final community = c.communityId;
    return community == null || (mayReadIn?.call(community) ?? c.seededReader);
  }

  bool _canPost(_MockConversation c) {
    final community = c.communityId;
    return community == null
        ? c.canPost
        : mayPostIn?.call(community) ?? c.canPost;
  }

  Conversation _view(_MockConversation c) => c.view(canPost: _canPost(c));

  Future<void> _wait() =>
      latency == Duration.zero ? Future.value() : Future.delayed(latency);

  void _seed() {
    final direct = _MockConversation(
      id: 'mock-direct',
      type: ConversationType.direct,
      title: 'الأستاذ عبدالله',
      counterpartUserId: _teacher,
      memberCount: 2,
      myRole: ParticipantRole.member,
      canPost: true,
      createdAt: _start,
      names: const {_teacher: 'الأستاذ عبدالله', viewer: 'طالب تجريبي'},
    );
    final lines = [
      (_teacher, 'السلام عليكم ورحمة الله، كيف حال مراجعتك لسورة الملك؟'),
      (viewer, 'وعليكم السلام ورحمة الله، الحمد لله أتممت نصفها.'),
      (_teacher, 'أحسنت. ركّز على أحكام المدّ في الآيات الأخيرة.'),
      (viewer, 'إن شاء الله.'),
      (_teacher, 'سأستمع لتلاوتك في الحلقة القادمة بإذن الله.'),
      (_teacher, 'لا تنسَ تسجيل التلاوة وإرسالها قبل الخميس.'),
    ];
    for (var i = 0; i < lines.length; i++) {
      direct.add(
        senderId: lines[i].$1,
        type: MessageType.text,
        body: lines[i].$2,
        at: _start.add(Duration(minutes: 7 * i)),
      );
    }
    direct.lastRead = 4;

    final group = _MockConversation(
      id: 'mock-group',
      type: ConversationType.group,
      title: 'حلقة الفجر — التلاوة',
      memberCount: 4,
      myRole: ParticipantRole.member,
      canPost: true,
      createdAt: _start.subtract(const Duration(days: 3)),
      names: const {
        _teacher: 'الأستاذ عبدالله',
        viewer: 'طالب تجريبي',
        'mock-peer-1': 'أحمد',
        'mock-peer-2': 'يوسف',
      },
    );
    const speakers = [_teacher, 'mock-peer-1', 'mock-peer-2', viewer];
    for (var i = 1; i <= 36; i++) {
      final speaker = speakers[i % speakers.length];
      group.add(
        senderId: speaker,
        type: MessageType.text,
        body: speaker == _teacher
            ? 'تنبيه الحلقة رقم $i: راجعوا الوجه المقرر قبل الفجر.'
            : 'تمّت مراجعة الوجه $i بحمد الله.',
        at: _start.subtract(Duration(hours: 40 - i)),
        // One message answers an earlier one, so the reply quote has real data
        // to render (replyToMessageId is a server-backed field). It keeps the
        // 36-message topology other tests rely on — no message is added.
        replyToMessageId: i == 10 ? 'mock-group-m8' : null,
      );
    }
    group.lastRead = 31;

    final channel = _MockConversation(
      id: 'mock-channel',
      type: ConversationType.channel,
      title: 'إعلانات المعهد',
      memberCount: 120,
      myRole: ParticipantRole.member,
      canPost: false,
      createdAt: _start.subtract(const Duration(days: 10)),
      names: const {_admin: 'إدارة المعهد'},
    );
    for (final (i, text) in [
      'يبدأ التسجيل في دورة التجويد المكثفة يوم الأحد.',
      'تذكير: الحلقات مستمرة خلال الإجازة الأسبوعية.',
      'نبارك للطلاب المجازين في سورة البقرة.',
    ].indexed) {
      channel.add(
        senderId: _admin,
        type: MessageType.text,
        body: text,
        at: _start.subtract(Duration(days: 3 - i)),
      );
    }
    channel.lastRead = 2;

    for (final c in [direct, group, channel, ..._communityChats()]) {
      _conversations[c.id] = c;
    }
  }

  /// One chat per demo community, quieter than the conversations above:
  /// everything in them has been read. The last is the chat of the
  /// community the viewer starts outside of, theirs to read once they join.
  List<_MockConversation> _communityChats() {
    final chats = <_MockConversation>[];
    for (final (index, (communityId, title, members, reader, canPost, lines))
        in [
          (
            MockCommunityRepository.openId,
            'مجتمع طلاب التجويد',
            24,
            true,
            false,
            [
              'مرحبًا بكم في مجتمع طلاب التجويد.',
              'درس أحكام النون الساكنة يوم الأحد بإذن الله.',
            ],
          ),
          (
            MockCommunityRepository.ownedId,
            'مجتمع أسرة الحفظ',
            12,
            true,
            true,
            ['نلتقي بعد صلاة المغرب لمراجعة الورد.'],
          ),
          (
            MockCommunityRepository.delegatedId,
            'مجتمع حلقة المساء',
            64,
            true,
            false,
            ['موعد حلقة المساء بعد صلاة العشاء.'],
          ),
          (
            MockCommunityRepository.lockedId,
            'مجتمع المراجعة الأسبوعية',
            18,
            true,
            false,
            ['تمّت مراجعة جزء عمّ هذا الأسبوع بحمد الله.'],
          ),
          (
            MockCommunityRepository.largeId,
            'مجتمع طلاب المعهد',
            30000,
            true,
            false,
            ['أهلًا بكم في مجتمع طلاب المعهد.'],
          ),
          (
            MockCommunityRepository.invitedId,
            'مجتمع حلقة الفجر',
            40,
            false,
            false,
            [
              'أهلًا بكم في مجتمع حلقة الفجر.',
              'نلتقي بعد صلاة الفجر لتلاوة الورد اليومي.',
            ],
          ),
        ].indexed) {
      final chat = _MockConversation(
        id: '$communityId-chat',
        type: ConversationType.channel,
        title: title,
        memberCount: members,
        myRole: ParticipantRole.member,
        canPost: canPost,
        seededReader: reader,
        createdAt: _start.subtract(Duration(days: 20 + index)),
        names: const {_teacher: 'الأستاذ عبدالله', viewer: 'طالب تجريبي'},
        communityId: communityId,
        // Every demo community is a group (the mock community repository seeds
        // them all GROUP_RESTRICTED → kind GROUP); none is a channel. So the
        // header names these chats "group", not "channel".
        communityKind: CommunityKind.group,
      );
      for (final (i, text) in lines.indexed) {
        chat.add(
          senderId: _teacher,
          type: MessageType.text,
          body: text,
          at: _start.subtract(Duration(days: 5 + index, hours: 2 - i)),
        );
      }
      chat.lastRead = chat.lastSequence;
      chats.add(chat);
    }
    return chats;
  }
}

class _MockConversation {
  _MockConversation({
    required this.id,
    required this.type,
    required this.title,
    required this.memberCount,
    required this.myRole,
    required this.canPost,
    required this.createdAt,
    required this.names,
    this.counterpartUserId,
    this.communityId,
    this.communityKind,
    this.seededReader = true,
  });

  final String id;
  final ConversationType type;
  final String title;
  final String? counterpartUserId;
  final int memberCount;
  final ParticipantRole myRole;

  /// As seeded; a community's chat answers by its community when this mock
  /// runs beside the demo's communities.
  final bool canPost;
  final DateTime createdAt;

  /// A community chat the viewer reads as seeded: one of a community they
  /// start in.
  final bool seededReader;
  final Map<String, String> names;
  final String? communityId;

  /// For a community chat, the community's product kind (ADR 0039) — so the
  /// header names a group a "group" though the chat's transport [type] is
  /// CHANNEL (Q51). Null for the non-community demo conversations.
  final CommunityKind? communityKind;

  final List<Message> messages = [];
  final Map<String, Message> byClientId = {};

  /// Originals of messages a moderator deleted, kept for the review window
  /// (ADR 0029). The demo does not expire them.
  final Map<String, _DeletedOriginal> deleted = {};
  int lastRead = 0;

  /// The single pinned message's id (ADR 0043), or null.
  String? pinnedMessageId;

  /// The pin's total-order version — bumped only on an actual change, like the
  /// server (ADR 0043 §realtime).
  int pinVersion = 0;

  int get lastSequence => messages.isEmpty ? 0 : messages.last.sequence;
  DateTime get activityAt =>
      messages.isEmpty ? createdAt : messages.last.createdAt;

  Message add({
    required String senderId,
    required MessageType type,
    required DateTime at,
    String? body,
    String? clientMessageId,
    String? replyToMessageId,
    List<Attachment> attachments = const [],
  }) {
    final message = Message(
      id: '$id-m${lastSequence + 1}',
      conversationId: id,
      sequence: lastSequence + 1,
      senderId: senderId,
      type: type,
      body: body,
      clientMessageId: clientMessageId,
      replyToMessageId: replyToMessageId,
      createdAt: at,
      attachments: attachments,
    );
    messages.add(message);
    if (clientMessageId != null) byClientId[clientMessageId] = message;
    return message;
  }

  Conversation view({required bool canPost}) {
    final unread = messages
        .where(
          (m) =>
              m.sequence > lastRead &&
              m.senderId != MockMessagingRepository.viewer &&
              !m.isDeleted,
        )
        .length;
    final last = messages.isEmpty ? null : messages.last;
    return Conversation(
      id: id,
      type: type,
      title: title,
      counterpartUserId: counterpartUserId,
      memberCount: memberCount,
      myRole: myRole,
      canPost: canPost,
      canManageMembers: false,
      lastSequence: lastSequence,
      lastReadSequence: lastRead,
      unreadCount: unread < Conversation.unreadCountCap
          ? unread
          : Conversation.unreadCountCap,
      lastMessage: last == null
          ? null
          : MessagePreview(
              sequence: last.sequence,
              senderId: last.senderId,
              senderName: names[last.senderId],
              type: last.type,
              text: last.body,
              deleted: last.isDeleted,
              createdAt: last.createdAt,
            ),
      createdAt: createdAt,
      activityAt: activityAt,
      communityId: communityId,
      communityKind: communityKind,
      pinnedMessageId: pinnedMessageId,
      pinVersion: pinVersion,
      origin: DataOrigin.mock,
    );
  }
}

/// A message a moderator deleted, kept so the review can reveal its original
/// (ADR 0029): the message as it was, who deleted it, and when.
class _DeletedOriginal {
  const _DeletedOriginal(this.original, this.by, this.at);

  final Message original;
  final String by;
  final DateTime at;
}
