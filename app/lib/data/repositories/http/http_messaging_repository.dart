import '../../api/api_client.dart';
import '../../models/messaging.dart';
import '../repositories.dart';

/// [MessagingRepository] against the real backend (`/messaging/*`, `/files/*`).
class HttpMessagingRepository implements MessagingRepository {
  HttpMessagingRepository(this._api, this._auth);

  final ApiClient _api;
  final AuthRepository _auth;

  /// clientMessageId → completed upload. A send that failed AFTER its upload
  /// is retried with the same file, never uploaded twice.
  final Map<String, String> _uploads = {};

  static String _conversation(String id) =>
      '/messaging/conversations/${Uri.encodeComponent(id)}';

  @override
  Future<String> viewerId() async {
    final user = await _auth.currentUser();
    if (user == null) {
      throw const MessagingException(
        'identity.authentication_required',
        'Sign in to see your messages.',
      );
    }
    return user.id;
  }

  @override
  Future<ConversationPage> conversations({String? cursor}) => _call(
    () async => ConversationPage.fromJson(
      await _api.get('/messaging/conversations', query: {'cursor': ?cursor}),
    ),
  );

  @override
  Future<Conversation> conversation(String conversationId) => _call(
    () async =>
        Conversation.fromJson(await _api.get(_conversation(conversationId))),
  );

  @override
  Future<MessagePage> messages(
    String conversationId, {
    int? before,
    int? after,
    int limit = 30,
  }) => _call(
    () async => MessagePage.fromJson(
      await _api.get(
        '${_conversation(conversationId)}/messages',
        query: {
          'before': ?before?.toString(),
          'after': ?after?.toString(),
          'limit': '$limit',
        },
      ),
    ),
  );

  @override
  Future<Message> sendText(
    String conversationId, {
    required String clientMessageId,
    required String body,
  }) => _call(
    () async => Message.fromJson(
      await _api.post(
        '${_conversation(conversationId)}/messages/text',
        body: {'clientMessageId': clientMessageId, 'body': body},
      ),
    ),
  );

  @override
  Future<Message> sendVoice(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile recording,
  }) => _sendMedia(conversationId, 'voice', clientMessageId, recording, null);

  @override
  Future<Message> sendImage(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile image,
    String? caption,
  }) => _sendMedia(conversationId, 'image', clientMessageId, image, caption);

  @override
  Future<Message> sendFile(
    String conversationId, {
    required String clientMessageId,
    required OutgoingFile file,
    String? caption,
  }) => _sendMedia(conversationId, 'file', clientMessageId, file, caption);

  @override
  Future<int> markRead(String conversationId, int sequence) => _call(() async {
    final json = await _api.post(
      '${_conversation(conversationId)}/read',
      body: {'sequence': sequence},
    );
    return json['lastReadSequence']! as int;
  });

  @override
  Future<Uri> attachmentUrl(
    String conversationId,
    String messageId,
    String fileAssetId,
  ) => _call(() async {
    final json = await _api.get(
      '${_conversation(conversationId)}/messages/${Uri.encodeComponent(messageId)}'
      '/attachments/${Uri.encodeComponent(fileAssetId)}/link',
    );
    return _api.resolve(json['url']! as String);
  });

  Future<Message> _sendMedia(
    String conversationId,
    String route,
    String clientMessageId,
    OutgoingFile file,
    String? caption,
  ) => _call(() async {
    final assetId = _uploads[clientMessageId] ??= await _upload(file);
    final message = Message.fromJson(
      await _api.post(
        '${_conversation(conversationId)}/messages/$route',
        body: {
          'clientMessageId': clientMessageId,
          'fileAssetId': assetId,
          'caption': ?caption,
        },
      ),
    );
    _uploads.remove(clientMessageId);
    return message;
  });

  /// Declare → PUT the bytes to the signed URL → ask the server to verify.
  Future<String> _upload(OutgoingFile file) async {
    final ticket = await _api.post(
      '/files/uploads',
      body: {
        'kind': file.kind.wire,
        'contentType': file.contentType,
        'byteSize': file.bytes.length,
        'fileName': file.fileName,
        'durationMs': ?file.durationMs,
        'width': ?file.width,
        'height': ?file.height,
      },
    );
    final asset = (ticket['asset']! as Map).cast<String, Object?>();
    final upload = (ticket['upload']! as Map).cast<String, Object?>();
    final assetId = asset['id']! as String;

    // 409 means an earlier attempt already delivered these bytes.
    await _api.putBytes(
      _api.resolve(upload['url']! as String),
      file.bytes,
      (upload['headers']! as Map).cast<String, String>(),
    );
    await _api.post('/files/uploads/${Uri.encodeComponent(assetId)}/complete');
    return assetId;
  }

  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw MessagingException(error.code, error.message);
    }
  }
}
