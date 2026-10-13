import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/admin.dart';
import '../../../providers/app_providers.dart';

class AdminAccountsState {
  const AdminAccountsState({
    required this.items,
    this.nextCursor,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  /// The institution's accounts, newest-registered first, each once.
  final List<AdminAccount> items;
  final String? nextCursor;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;

  AdminAccountsState copyWith({
    List<AdminAccount>? items,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) => AdminAccountsState(
    items: items ?? this.items,
    nextCursor: nextCursor,
    loadingMore: loadingMore ?? this.loadingMore,
    loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
  );
}

/// The institution's accounts, a keyset page at a time — for staff who may read
/// them (`users.read`). The server is the authority on every read and on the
/// create; this never recomputes who may act.
class AdminAccountsController extends AsyncNotifier<AdminAccountsState> {
  @override
  Future<AdminAccountsState> build() async {
    final page = await ref.watch(adminRepositoryProvider).accounts();
    return AdminAccountsState(items: page.items, nextCursor: page.nextCursor);
  }

  /// The next page, appended. A failure keeps what is shown and offers retry.
  Future<void> loadMore() async {
    final current = state.value;
    if (current == null ||
        state.isLoading ||
        !current.hasMore ||
        current.loadingMore) {
      return;
    }
    state = AsyncData(
      current.copyWith(loadingMore: true, loadMoreFailed: false),
    );
    try {
      final page = await ref
          .read(adminRepositoryProvider)
          .accounts(cursor: current.nextCursor);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      final seen = {for (final a in now.items) a.id};
      state = AsyncData(
        AdminAccountsState(
          items: [
            ...now.items,
            for (final a in page.items)
              if (!seen.contains(a.id)) a,
          ],
          nextCursor: page.nextCursor,
        ),
      );
    } on AdminException {
      if (!ref.mounted) return;
      state = AsyncData(
        (state.value ?? current).copyWith(
          loadingMore: false,
          loadMoreFailed: true,
        ),
      );
    }
  }

  Future<void> refresh() async {
    ref.invalidateSelf();
    await future;
  }

  /// Provisions a new account and returns it (status PENDING, no roles). One
  /// request; throws [AdminException] on refusal (nothing is created). The
  /// caller reads the list again (the new account heads it) — the server is
  /// re-authorised on the create.
  Future<AdminAccount> create({
    required String displayName,
    required String identifier,
    required String initialPassword,
  }) => ref
      .read(adminRepositoryProvider)
      .createAccount(
        displayName: displayName,
        identifier: identifier,
        initialPassword: initialPassword,
      );
}

final adminAccountsProvider =
    AsyncNotifierProvider.autoDispose<
      AdminAccountsController,
      AdminAccountsState
    >(
      AdminAccountsController.new,
      // Failures surface at once with a retry button; no silent backoff.
      retry: (_, _) => null,
    );
