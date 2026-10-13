import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/admin.dart';
import '../../providers/app_providers.dart';
import 'admin_copy.dart';
import 'state/admin_accounts_controller.dart';
import 'widgets/admin_create_account_sheet.dart';

/// إدارة الحسابات — the institution's accounts, for staff who may read them
/// (`users.read`). Creating an account is offered only to a holder of
/// `users.manage`; the server re-authorises every list and every create.
class AdminAccountsScreen extends ConsumerWidget {
  const AdminAccountsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canCreate = ref.watch(
      sessionUserProvider.select(
        (session) => session.value?.can('users.manage') ?? false,
      ),
    );
    return Scaffold(
      appBar: AppBar(
        title: const Text(AdminCopy.screenTitle),
        actions: [
          IconButton(
            tooltip: AdminCopy.refresh,
            onPressed: () => ref.invalidate(adminAccountsProvider),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      floatingActionButton: canCreate
          ? FloatingActionButton.extended(
              key: const Key('admin-create-account-fab'),
              onPressed: () => showCreateAccount(context),
              icon: const Icon(Icons.person_add_alt_1_outlined),
              label: const Text(AdminCopy.createAccount),
            )
          : null,
      body: const SafeArea(top: false, child: _AccountsList()),
    );
  }
}

class _AccountsList extends ConsumerWidget {
  const _AccountsList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accounts = ref.watch(adminAccountsProvider);
    return AsyncView(
      value: accounts,
      onRetry: () => ref.invalidate(adminAccountsProvider),
      loading: const SingleChildScrollView(
        child: Padding(
          padding: EdgeInsets.only(top: Insets.giant),
          child: Center(child: CircularProgressIndicator()),
        ),
      ),
      builder: (context, state) {
        if (state.items.isEmpty) {
          return const SingleChildScrollView(
            child: EmptyState(
              icon: Icons.manage_accounts_outlined,
              title: AdminCopy.empty,
              message: AdminCopy.emptyMessage,
            ),
          );
        }
        final demo = state.items.any((a) => a.origin.isMock);
        return RefreshIndicator(
          onRefresh: () => ref.read(adminAccountsProvider.notifier).refresh(),
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: Insets.giant),
            itemCount: state.items.length + 2,
            itemBuilder: (context, index) {
              if (index == 0) {
                return demo
                    ? const ResponsiveBody(
                        child: Padding(
                          padding: EdgeInsets.symmetric(vertical: Insets.md),
                          child: MockBanner(message: AdminCopy.demoBanner),
                        ),
                      )
                    : const SizedBox(height: Insets.md);
              }
              if (index == state.items.length + 1) return _Footer(state: state);
              final account = state.items[index - 1];
              return ResponsiveBody(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Insets.sm),
                  child: _AccountTile(
                    account: account,
                    onTap: () => context.push(Routes.adminAccount(account.id)),
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }
}

class _AccountTile extends StatelessWidget {
  const _AccountTile({required this.account, this.onTap});

  final AdminAccount account;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final email = account.primaryIdentifier ?? AdminCopy.noIdentifier;
    return AppCard(
      onTap: onTap,
      semanticLabel: account.displayName,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.account_circle_outlined,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(account.displayName, style: context.text.titleSmall),
                const SizedBox(height: 4),
                Text(
                  email,
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '${AdminCopy.status(account.status)} · ${AdminCopy.roles(account.roles)}',
                  style: context.text.bodySmall,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The end of the list: more to load, loading, or a retry after a failure.
class _Footer extends ConsumerWidget {
  const _Footer({required this.state});

  final AdminAccountsState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!state.hasMore) return const SizedBox.shrink();
    if (state.loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return Center(
      child: TextButton(
        onPressed: () => ref.read(adminAccountsProvider.notifier).loadMore(),
        child: Text(
          state.loadMoreFailed ? AdminCopy.loadMoreFailed : AdminCopy.loadMore,
        ),
      ),
    );
  }
}
