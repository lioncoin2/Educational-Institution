import '../../models/files.dart';
import '../../models/messaging.dart' show OutgoingFile;
import '../repositories.dart';

/// [FilesRepository] for the demo — there is no file storage, so no picture is
/// uploaded, set or served. Every operation reports that plainly, and the UI
/// falls back to the default (initials) view, exactly as it does on the server
/// for an account with no picture. The profile-picture screen is shown only in
/// backend mode, so this is reached only by a test that exercises it directly.
class MockFilesRepository implements FilesRepository {
  const MockFilesRepository();

  static const _unavailable = FilesException(
    'files.unavailable',
    'Pictures are not stored in the demo.',
  );

  @override
  Future<String> uploadImage(OutgoingFile image) async => throw _unavailable;

  @override
  Future<String> upload(OutgoingFile file) async =>
      // The demo keeps no storage, but a mass-publish needs a reference to
      // attach; a deterministic, clearly-invented id lets the demo flow run.
      'demo-asset-${file.kind.wire.toLowerCase()}';

  @override
  Future<void> setMyAvatar(String fileAssetId) async => throw _unavailable;

  @override
  Future<void> removeMyAvatar() async {
    // Nothing to remove in the demo; succeed silently.
  }

  @override
  Future<Uri> ownAssetLink(String fileAssetId) async => throw _unavailable;
}
