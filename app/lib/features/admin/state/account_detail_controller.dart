import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/admin.dart';
import '../../../data/models/auth.dart' show AccountStatus;
import '../../../providers/app_providers.dart';
import 'admin_accounts_controller.dart';

/// One account's full record and its lifecycle administration, for a holder of
/// `users.read` (read) and the matching capability per act — `roles.assign`,
/// `users.manage`, `sessions.manage`. Every write goes to the server, which
/// re-authorises and enforces the self/outrank/transition rules; a refusal
/// throws [AdminException] and changes nothing. Role and status writes return
/// the fresh account and replace the state in place (no reload flash); the
/// directory list is invalidated so it reflects the change when next shown.
class AccountDetailController extends AsyncNotifier<AdminAccount> {
  AccountDetailController(this.userId);

  final String userId;

  @override
  Future<AdminAccount> build() {
    ref.watch(adminRepositoryProvider);
    return ref.read(adminRepositoryProvider).account(userId);
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  Future<void> assignRole(String role) async {
    _set(
      await ref.read(adminRepositoryProvider).assignRole(userId, role: role),
    );
  }

  Future<void> removeRole(String role) async {
    _set(
      await ref.read(adminRepositoryProvider).removeRole(userId, role: role),
    );
  }

  Future<void> setStatus(AccountStatus status) async {
    _set(
      await ref.read(adminRepositoryProvider).setStatus(userId, status: status),
    );
  }

  /// Sets a new password; nothing is returned or stored, so no state changes.
  Future<void> resetPassword(String newPassword) => ref
      .read(adminRepositoryProvider)
      .resetPassword(userId, newPassword: newPassword);

  /// Ends every session the account holds; returns how many. The account's
  /// state is unchanged (sessions are not part of the record shown).
  Future<int> revokeSessions() =>
      ref.read(adminRepositoryProvider).revokeSessions(userId);

  void _set(AdminAccount account) {
    state = AsyncData(account);
    ref.invalidate(adminAccountsProvider);
  }
}

final accountDetailProvider = AsyncNotifierProvider.autoDispose
    .family<AccountDetailController, AdminAccount, String>(
      AccountDetailController.new,
      retry: (_, _) => null,
    );
