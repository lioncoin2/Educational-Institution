/// A refusal from a files operation (upload, avatar set/clear, a link).
///
/// Carries the server's stable code (`files.asset_not_found`,
/// `files.asset_kind_not_accepted`, a rate limit, …) so the UI can tell the
/// person what went wrong without the HTTP layer leaking out.
class FilesException implements Exception {
  const FilesException(this.code, this.message);

  final String code;
  final String message;

  bool get isNetwork => code == 'network.unreachable';

  @override
  String toString() => 'FilesException($code): $message';
}
