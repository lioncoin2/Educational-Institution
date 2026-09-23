import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/backend_config.dart';
import '../../app/routes.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../providers/app_providers.dart';
import 'state/conversation_list_controller.dart';
import 'widgets/connection_banner.dart';
import 'widgets/conversation_tile.dart';

/// The signed-in person's conversations, most recently active first.
class ConversationsScreen extends ConsumerWidget {
  const ConversationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('الرسائل'),
        actions: [
          IconButton(
            tooltip: 'تحديث',
            onPressed: () => ref.invalidate(conversationListProvider),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        // Against the real backend, a session comes first; the demo build
        // runs on mock data and needs none.
        child: BackendConfig.isConfigured
            ? AsyncView(
                value: ref.watch(sessionUserProvider),
                onRetry: () => ref.invalidate(sessionUserProvider),
                builder: (context, user) => user == null
                    ? EmptyState(
                        icon: Icons.lock_outline_rounded,
                        title: 'سجّل الدخول لعرض رسائلك',
                        actionLabel: 'تسجيل الدخول',
                        onAction: () => context.push(Routes.signIn),
                      )
                    : const Column(
                        children: [
                          ConnectionBanner(),
                          Expanded(child: _ConversationList()),
                        ],
                      ),
              )
            : const _ConversationList(),
      ),
    );
  }
}

class _ConversationList extends ConsumerWidget {
  const _ConversationList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conversations = ref.watch(conversationListProvider);
    return AsyncView(
      value: conversations,
      onRetry: () => ref.invalidate(conversationListProvider),
      builder: (context, state) {
        if (state.items.isEmpty) {
          return const EmptyState(
            icon: Icons.forum_outlined,
            title: 'لا توجد محادثات بعد',
            message: 'تظهر هنا المحادثات التي يضيفك إليها معلّموك.',
          );
        }
        return RefreshIndicator(
          onRefresh: () =>
              ref.read(conversationListProvider.notifier).refresh(),
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: Insets.giant),
            itemCount: state.items.length + 2,
            itemBuilder: (context, index) {
              if (index == 0) {
                return BackendConfig.isConfigured
                    ? const SizedBox(height: Insets.md)
                    : const ResponsiveBody(
                        child: Padding(
                          padding: EdgeInsets.symmetric(vertical: Insets.md),
                          child: MockBanner(
                            message:
                                'محادثات تجريبية للعرض فقط. عند ربط التطبيق '
                                'بالخادم تظهر محادثاتك الحقيقية هنا.',
                          ),
                        ),
                      );
              }
              if (index == state.items.length + 1) return _Footer(state: state);
              final conversation = state.items[index - 1];
              return ResponsiveBody(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Insets.sm),
                  child: ConversationTile(
                    conversation: conversation,
                    onTap: () =>
                        context.push(Routes.conversation(conversation.id)),
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

/// The end of the list: more to load, loading, or a retry after a failure.
class _Footer extends ConsumerWidget {
  const _Footer({required this.state});

  final ConversationListState state;

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
        onPressed: () => ref.read(conversationListProvider.notifier).loadMore(),
        child: Text(
          state.loadMoreFailed
              ? 'تعذّر التحميل — إعادة المحاولة'
              : 'عرض المزيد',
        ),
      ),
    );
  }
}
