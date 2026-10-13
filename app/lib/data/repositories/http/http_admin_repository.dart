import '../../api/api_client.dart';
import '../../models/admin.dart';
import '../../models/auth.dart' show AccountStatus;
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

  // ── Account lifecycle (users.read / users.manage / roles.assign / sessions.manage) ──
  // Role and status writes return the fresh account, so the detail re-renders
  // from the server's truth. The password is sent once (204, nothing back) and
  // kept nowhere. Session revocation returns only a count. The server
  // re-authorises and enforces self/outrank/transition rules; refusals flow
  // through [_call] keeping their code.

  static String _user(String id) => '/admin/users/${Uri.encodeComponent(id)}';

  @override
  Future<AdminAccount> account(String userId) => _call(
    () async => AdminAccount.fromJson(
      await _api.get(_user(userId)),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<AdminAccount> assignRole(String userId, {required String role}) =>
      _call(
        () async => AdminAccount.fromJson(
          await _api.post('${_user(userId)}/roles', body: {'role': role}),
          origin: DataOrigin.records,
        ),
      );

  @override
  Future<AdminAccount> removeRole(String userId, {required String role}) =>
      _call(
        () async => AdminAccount.fromJson(
          await _api.delete(
            '${_user(userId)}/roles/${Uri.encodeComponent(role)}',
          ),
          origin: DataOrigin.records,
        ),
      );

  @override
  Future<AdminAccount> setStatus(
    String userId, {
    required AccountStatus status,
  }) => _call(
    () async => AdminAccount.fromJson(
      await _api.post('${_user(userId)}/status', body: {'status': status.wire}),
      origin: DataOrigin.records,
    ),
  );

  @override
  Future<void> resetPassword(String userId, {required String newPassword}) =>
      _call(() async {
        await _api.post(
          '${_user(userId)}/password',
          body: {'newPassword': newPassword},
        );
      });

  @override
  Future<int> revokeSessions(String userId) => _call(() async {
    final json = await _api.delete('${_user(userId)}/sessions');
    return (json['sessionsEnded'] as num?)?.toInt() ?? 0;
  });

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
