import '../../api/api_client.dart';
import '../../models/files.dart';
import '../../models/messaging.dart' show OutgoingFile;
import '../repositories.dart';

/// [FilesRepository] against the real backend (`/files/*`).
///
/// An upload is the three-call flow the server verifies: declare it
/// (`POST /files/uploads`), PUT the bytes to the signed URL it returns, then
/// complete it (`POST /files/uploads/:id/complete`). The resulting asset id is
/// a reference; binding it (as an avatar) is a separate, re-authorised call.
class HttpFilesRepository implements FilesRepository {
  HttpFilesRepository(this._api);

  final ApiClient _api;

  @override
  Future<String> uploadImage(OutgoingFile image) => _call(() => _upload(image));

  @override
  Future<String> upload(OutgoingFile file) => _call(() => _upload(file));

  @override
  Future<void> setMyAvatar(String fileAssetId) =>
      _call(() => _api.put('/files/me/avatar', body: {'fileAssetId': fileAssetId}));

  @override
  Future<void> removeMyAvatar() => _call(() => _api.delete('/files/me/avatar'));

  @override
  Future<Uri> ownAssetLink(String fileAssetId) => _call(() async {
    final json = await _api.post(
      '/files/me/assets/${Uri.encodeComponent(fileAssetId)}/link',
    );
    return _api.resolve(json['url']! as String);
  });

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
      throw FilesException(error.code, error.message);
    }
  }
}
