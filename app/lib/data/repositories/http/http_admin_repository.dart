import '../../api/api_client.dart';
import '../../models/admin.dart';
import '../../models/data_origin.dart';
import '../repositories.dart';

/// [AdminRepository] against the real backend (`/admin/users`).
///
/// No page size is sent — the server's default page is the one the screen is
/// built for, walked only as far as someone scrolls. The create body carries
/// exactly what the route takes; the password is sent once and kept nowhere.
/// Every transport and parsing failure becomes an [AdminException], keeping the
/// server's code.
class HttpAdminRepository implements AdminRepository {
  HttpAdminRepository(this._api);

  final ApiClient _api;

  @override
  Future<AdminAccountPage> accounts({String? cursor}) => _call(
    () async => AdminAccountPage.fromJson(
      await _api.get('/admin/users', query: {'cursor': ?cursor}),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<AdminAccount> createAccount({
    required String displayName,
    required String identifier,
    required String initialPassword,
  }) => _call(
    () async => AdminAccount.fromJson(
      await _api.post(
        '/admin/users',
        body: {
          'displayName': displayName,
          // Only 'email' is a valid identifier kind today; sent explicitly.
          'identifierType': 'email',
          'identifier': identifier,
          'initialPassword': initialPassword,
        },
      ),
      origin: DataOrigin.records,
    ),
  );

  static const _unreadable = AdminException(
    'admin.unreadable',
    'The server sent something this app cannot read.',
  );

  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw AdminException(
        error.code,
        error.message,
        details: error.details ?? const {},
      );
    } on FormatException {
      throw _unreadable;
    } on TypeError {
      throw _unreadable;
    }
  }
}
