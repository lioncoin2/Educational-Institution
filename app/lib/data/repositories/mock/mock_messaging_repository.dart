import '../../../app/app_config.dart';
import '../../models/data_origin.dart';
import '../../models/messaging.dart';
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
/// resolved from the community by [conversationForCommunity]. Posting in it
/// is what the community allows — its owner, while it is open and small
/// enough to be served; everyone else reads.
class MockMessagingRepository implements MessagingRepository {
  MockMessagingRepository({this.latency = AppConfig.fakeLatency}) {
    _seed();
  }

  final Duration latency;

  static const String viewer = 'mock-student';
  static const String _teacher = 'mock-teacher';
  static const String _admin = 'mock-admin';

  final Map<String, _MockConversation> _conversations = {};

  static final DateTime _start = DateTime.utc(2026, 9, 1, 5, 30);

  @override
  Future<String> viewerId() async => viewer;

  @override
  Future<ConversationPage> conversations({String? cursor}) async {
    await _wait();
    final all = _conversations.values.toList()
      ..sort((a, b) => b.activityAt.compareTo(a.activityAt));
    return ConversationPage(items: [for (final c in all) c.view()]);
  }

  @override
  Future<Conversation> conversation(String conversationId) async {
    await _wait();
    return _find(conversationId).view();
  }

  @override
  Future<Conversation> conversationForCommunity(String communityId) async {
    await _wait();
    final chat = _conversations.values
        .where((c) => c.communityId == communityId)
        .firstOrNull;
    if (chat == null) {
      // An unknown community and one that is not the viewer's are answered
      // alike.
      throw const MessagingException(
        'messaging.conversation_not_found',
        'No such conversation.',
      );
    }
    return chat.view();
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
    );
  }

  @override
  Future<Message> sendVoice(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile recording,
  }) => _media(
    conversationId,
    clientMessageId,
    MessageType.voice,
    recording,
    null,
  );

  @override
  Future<Message> sendImage(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile image,
    String? caption,
  }) => _media(
    conversationId,
    clientMessageId,
    MessageType.image,
    image,
    caption,
  );

  @override
  Future<Message> sendFile(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile file,
    String? caption,
  }) =>
      _media(conversationId, clientMessageId, MessageType.file, file, caption);

  @override
  Future<int> markRead(String conversationId, int sequence) async {
    await _wait();
    final c = _find(conversationId);
    final target = sequence < c.lastSequence ? sequence : c.lastSequence;
    if (target > c.lastRead) c.lastRead = target;
    return c.lastRead;
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

  Future<Message> _media(
    String conversationId,
    String clientMessageId,
    MessageType type,
    OutgoingFile file,
    String? caption,
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
    );
  }

  Message _append(
    String conversationId,
    String clientMessageId,
    MessageType type,
    String? body,
    List<Attachment> attachments,
  ) {
    final c = _find(conversationId);
    if (!c.canPost) {
      throw const MessagingException(
        'messaging.posting_not_allowed',
        'Only the owner and publishers may post in this channel.',
      );
    }
    final existing = c.byClientId[clientMessageId];
    if (existing != null) {
      if (existing.type == type && existing.body == body) return existing;
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
  }) => _find(conversationId).add(
    senderId: senderId,
    type: MessageType.text,
    body: body,
    at: DateTime.now().toUtc(),
  );

  _MockConversation _find(String id) {
    final c = _conversations[id];
    if (c == null) {
      throw const MessagingException(
        'messaging.conversation_not_found',
        'No such conversation.',
      );
    }
    return c;
  }

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
  /// everything in them has been read.
  List<_MockConversation> _communityChats() {
    final chats = <_MockConversation>[];
    for (final (index, (communityId, title, members, canPost, lines)) in [
      (
        MockCommunityRepository.openId,
        'مجتمع طلاب التجويد',
        24,
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
        ['نلتقي بعد صلاة المغرب لمراجعة الورد.'],
      ),
      (
        MockCommunityRepository.delegatedId,
        'مجتمع حلقة المساء',
        64,
        false,
        ['موعد حلقة المساء بعد صلاة العشاء.'],
      ),
      (
        MockCommunityRepository.lockedId,
        'مجتمع المراجعة الأسبوعية',
        18,
        false,
        ['تمّت مراجعة جزء عمّ هذا الأسبوع بحمد الله.'],
      ),
      (
        MockCommunityRepository.largeId,
        'مجتمع طلاب المعهد',
        30000,
        false,
        ['أهلًا بكم في مجتمع طلاب المعهد.'],
      ),
    ].indexed) {
      final chat = _MockConversation(
        id: '$communityId-chat',
        type: ConversationType.channel,
        title: title,
        memberCount: members,
        myRole: ParticipantRole.member,
        canPost: canPost,
        createdAt: _start.subtract(Duration(days: 20 + index)),
        names: const {_teacher: 'الأستاذ عبدالله', viewer: 'طالب تجريبي'},
        communityId: communityId,
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
  });

  final String id;
  final ConversationType type;
  final String title;
  final String? counterpartUserId;
  final int memberCount;
  final ParticipantRole myRole;
  final bool canPost;
  final DateTime createdAt;
  final Map<String, String> names;
  final String? communityId;

  final List<Message> messages = [];
  final Map<String, Message> byClientId = {};
  int lastRead = 0;

  int get lastSequence => messages.isEmpty ? 0 : messages.last.sequence;
  DateTime get activityAt =>
      messages.isEmpty ? createdAt : messages.last.createdAt;

  Message add({
    required String senderId,
    required MessageType type,
    required DateTime at,
    String? body,
    String? clientMessageId,
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
      createdAt: at,
      attachments: attachments,
    );
    messages.add(message);
    if (clientMessageId != null) byClientId[clientMessageId] = message;
    return message;
  }

  Conversation view() {
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
      origin: DataOrigin.mock,
    );
  }
}
