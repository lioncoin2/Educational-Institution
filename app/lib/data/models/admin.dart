import 'auth.dart' show AccountStatus;
import 'data_origin.dart';

/// An institution account as the admin directory lists it (`GET /admin/users`)
/// and as account provisioning returns it (`POST /admin/users`).
///
/// Never a password, never a credential — only who the account is, its status,
/// its identifiers (today one email) and its roles.
class AdminAccount {
  const AdminAccount({
    required this.id,
    required this.displayName,
    required this.status,
    required this.identifiers,
    required this.roles,
    required this.createdAt,
    this.origin = DataOrigin.records,
  });

  factory AdminAccount.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => AdminAccount(
    id: json['id']! as String,
    displayName: json['displayName']! as String,
    status: AccountStatus.fromWire(json['status']! as String),
    identifiers: [
      for (final raw in (json['identifiers'] as List<Object?>? ?? const []))
        if (raw is Map)
          AccountIdentifier(
            type: raw['type']! as String,
            value: raw['value']! as String,
          ),
    ],
    roles: [
      for (final raw in (json['roles'] as List<Object?>? ?? const []))
        if (raw is Map) raw['code']! as String,
    ],
    createdAt: DateTime.parse(json['createdAt']! as String),
    origin: origin,
  );

  final String id;
  final String displayName;
  final AccountStatus status;
  final List<AccountIdentifier> identifiers;

  /// Role codes (OWNER/ADMIN/SUPERVISOR/TEACHER/ASSISTANT_TEACHER/STUDENT); a
  /// fresh account has none until a role is assigned.
  final List<String> roles;
  final DateTime createdAt;
  final DataOrigin origin;

  /// The primary identifier's value (today, the email) — null when the account
  /// has none the directory shows.
  String? get primaryIdentifier =>
      identifiers.isEmpty ? null : identifiers.first.value;
}

/// One way an account signs in — a type (today `email`) and its value.
class AccountIdentifier {
  const AccountIdentifier({required this.type, required this.value});

  final String type;
  final String value;
}

/// A keyset page of accounts, newest-registered first as the server orders it.
class AdminAccountPage {
  const AdminAccountPage({required this.items, this.nextCursor});

  factory AdminAccountPage.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) => AdminAccountPage(
    items: [
      for (final raw in (json['items'] as List<Object?>? ?? const []))
        AdminAccount.fromJson(
          (raw! as Map).cast<String, Object?>(),
          origin: origin,
        ),
    ],
    nextCursor: json['nextCursor'] as String?,
  );

  final List<AdminAccount> items;
  final String? nextCursor;
}

/// A refusal from `/admin/users`, carrying the backend's stable error code
/// (e.g. `identity.identifier_taken`, `identity.password_too_short`,
/// `identity.permission_denied`).
class AdminException implements Exception {
  const AdminException(this.code, this.message, {this.details = const {}});

  final String code;
  final String message;
  final Map<String, Object?> details;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';
  bool get isForbidden => code == 'identity.permission_denied';

  @override
  String toString() => 'AdminException($code): $message';
}
