import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/async_view.dart';
import '../../../core/widgets/foundations/empty_state.dart';
import '../../../core/widgets/layout/responsive_body.dart';
import '../../../data/models/tasks/tasks.dart';
import '../../auth/sign_in_prompt.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';

/// A server-paged list as every tasks screen shows one: loading, the
/// sign-in prompt or the refusal's sentence with a retry, an empty state,
/// pull-to-refresh and a load-more row.
class TasksPagedList<T> extends StatelessWidget {
  const TasksPagedList({
    super.key,
    required this.value,
    required this.itemBuilder,
    required this.onRefresh,
    required this.onLoadMore,
    required this.onRetry,
    required this.emptyIcon,
    required this.emptyTitle,
    this.emptyMessage,
    this.header,
  });

  final AsyncValue<TasksPage<T>> value;
  final Widget Function(BuildContext context, T item) itemBuilder;
  final Future<void> Function() onRefresh;
  final Future<void> Function() onLoadMore;
  final VoidCallback onRetry;
  final IconData emptyIcon;
  final String emptyTitle;
  final String? emptyMessage;

  /// Shown above the rows (filters, a summary) — also above the empty state.
  final Widget? header;

  @override
  Widget build(BuildContext context) {
    return AsyncView<TasksPage<T>>(
      value: value,
      onRetry: onRetry,
      errorBuilder: (context, error) =>
          SignInPrompt.forError(error, onReturn: onRetry) ?? _Refused(error: error, onRetry: onRetry),
      builder: (context, page) {
        final rows = page.items;
        final extra = (header == null ? 0 : 1) + (page.hasMore || rows.isEmpty ? 1 : 0);
        return RefreshIndicator(
          onRefresh: onRefresh,
          child: ListView.builder(
            padding: const EdgeInsets.symmetric(vertical: Insets.md),
            itemCount: rows.length + extra,
            itemBuilder: (context, index) {
              if (header != null) {
                if (index == 0) return ResponsiveBody(child: header!);
                index -= 1;
              }
              if (index < rows.length) {
                return ResponsiveBody(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: Insets.sm),
                    child: itemBuilder(context, rows[index]),
                  ),
                );
              }
              if (rows.isEmpty) {
                return ResponsiveBody(
                  child: EmptyState(icon: emptyIcon, title: emptyTitle, message: emptyMessage),
                );
              }
              return ResponsiveBody(child: _LoadMore(onLoadMore: onLoadMore));
            },
          ),
        );
      },
    );
  }
}

class _LoadMore extends StatefulWidget {
  const _LoadMore({required this.onLoadMore});

  final Future<void> Function() onLoadMore;

  @override
  State<_LoadMore> createState() => _LoadMoreState();
}

class _LoadMoreState extends State<_LoadMore> {
  bool _busy = false;

  Future<void> _load() async {
    setState(() => _busy = true);
    try {
      await widget.onLoadMore();
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text(TasksCopy.loadMoreFailed)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.sm),
      child: OutlinedButton(
        key: const Key('tasks-load-more'),
        onPressed: _busy ? null : _load,
        child: const Text(TasksCopy.loadMore),
      ),
    );
  }
}

/// A refusal other than "sign in": its sentence, and a retry.
class _Refused extends StatelessWidget {
  const _Refused({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      child: ResponsiveBody(
        child: EmptyState(
          icon: Icons.error_outline,
          title: TasksLabels.error(error),
          actionLabel: TasksCopy.refresh,
          onAction: onRetry,
        ),
      ),
    );
  }
}
