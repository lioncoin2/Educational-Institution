import 'data_origin.dart';

/// Account states, as the backend reports them.
///
/// [unknown] exists so a state added on the server later degrades to "cannot
/// use the app" on an old client, instead of crashing it.
enum AccountStatus {
  pending,
  active,
  suspended,
  disabled,
  unknown;

  static AccountStatus fromWire(String value) => switch (value) {
    'PENDING' => AccountStatus.pending,
    'ACTIVE' => AccountStatus.active,
    'SUSPENDED' => AccountStatus.suspended,
    'DISABLED' => AccountStatus.disabled,
    _ => AccountStatus.unknown,
  };
}

/// The signed-in account, as returned by `GET /auth/me`.
///
/// [permissions] decide what the UI offers — a hidden button is a courtesy,
/// never a control. The server re-checks every request regardless.
class CurrentUser implements Sourced {
  const CurrentUser({
    required this.id,
    required this.displayName,
    required this.status,
    required this.roles,
    required this.permissions,
    this.origin = DataOrigin.profile,
  });

  /// Parses the backend's `CurrentUserResponse` exactly.
  factory CurrentUser.fromJson(Map<String, Object?> json) => CurrentUser(
    id: json['id']! as String,
    displayName: json['displayName']! as String,
    status: AccountStatus.fromWire(json['status']! as String),
    roles: List<String>.unmodifiable(
      (json['roles']! as List<Object?>).cast<String>(),
    ),
    permissions: Set<String>.unmodifiable(
      (json['permissions']! as List<Object?>).cast<String>(),
    ),
  );

  final String id;
  final String displayName;
  final AccountStatus status;
  final List<String> roles;
  final Set<String> permissions;

  @override
  final DataOrigin origin;

  bool can(String permission) => permissions.contains(permission);
}

/// One signed-in device, as listed by `GET /auth/sessions`.
class DeviceSession {
  const DeviceSession({
    required this.id,
    required this.platform,
    required this.label,
    required this.lastUsedAt,
    required this.current,
  });

  factory DeviceSession.fromJson(Map<String, Object?> json) {
    final device = json['device']! as Map<String, Object?>;
    return DeviceSession(
      id: json['id']! as String,
      platform: device['platform']! as String,
      label: device['label'] as String?,
      lastUsedAt: DateTime.parse(json['lastUsedAt']! as String),
      current: json['current']! as bool,
    );
  }

  final String id;
  final String platform;
  final String? label;
  final DateTime lastUsedAt;

  /// The device this request came from.
  final bool current;
}

/// A refusal the UI should explain, carrying the backend's stable error code
/// (for example `identity.invalid_credentials`, `identity.account_suspended`).
class AuthException implements Exception {
  const AuthException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => 'AuthException($code): $message';
}
