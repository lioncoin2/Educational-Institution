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
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../data/models/command_center.dart';
import 'command_center_copy.dart';
import 'state/command_center_controller.dart';

/// The in-app route an action id opens, or null when this build has no screen
/// for it (a newer server action an older app does not know) — tapping such an
/// action says so plainly rather than navigating nowhere. The server already
/// decided WHICH actions the viewer may see; this only maps them to screens.
String? routeForCommandAction(String id) => switch (id) {
  'publish.communities' => Routes.publish,
  'communities.create' => Routes.communities,
  'academic.structure' => Routes.academicStructure,
  'accounts.admin' => Routes.adminAccounts,
  _ => null,
};

/// The Owner Command Center: the institution's facts the viewer is authorized to
/// see, grouped by the server's categories. Every figure is the server's — read
/// only, re-authorized server-side; the screen invents nothing, shows "no data"
/// where a summary has none, and offers loading, empty, error and retry.
class CommandCenterScreen extends ConsumerWidget {
  const CommandCenterScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(commandCenterProvider);
    return AppScreen(
      title: CommandCenterCopy.title,
      actions: [
        IconButton(
          tooltip: CommandCenterCopy.refresh,
          onPressed: () => ref.read(commandCenterProvider.notifier).refresh(),
          icon: const Icon(Icons.refresh_rounded),
        ),
        const SizedBox(width: Insets.sm),
      ],
      slivers: [
        SliverGutter(
          top: Insets.lg,
          child: AsyncView(
            value: value,
            loading: const _CommandCenterSkeleton(),
            errorBuilder: (context, error) => _CommandCenterError(
              error: error,
              onRetry: () => ref.invalidate(commandCenterProvider),
            ),
            builder: (context, center) {
              if (center.isEmpty) {
                return const EmptyState(
                  icon: Icons.dashboard_outlined,
                  title: CommandCenterCopy.empty,
                  message: CommandCenterCopy.emptyMessage,
                );
              }
              return _CommandCenterView(center: center);
            },
          ),
        ),
      ],
    );
  }
}

class _CommandCenterView extends StatelessWidget {
  const _CommandCenterView({required this.center});

  final CommandCenter center;

  @override
  Widget build(BuildContext context) {
    // Group by the server's category, preserving the order categories first
    // appear — the server decides what leads.
    final byCategory = <String, List<CommandWidget>>{};
    for (final widget in center.widgets) {
      byCategory.putIfAbsent(widget.category, () => []).add(widget);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (center.origin.isMock) ...[
          const MockBanner(message: CommandCenterCopy.demoBanner),
          const SizedBox(height: Insets.lg),
        ],
        if (center.actions.isNotEmpty) ...[
          const SectionHeader(title: CommandCenterCopy.actionsTitle),
          const SizedBox(height: Insets.md),
          _ActionsCard(actions: center.actions),
          const SizedBox(height: Insets.lg),
        ],
        for (final entry in byCategory.entries) ...[
          SectionHeader(title: CommandCenterCopy.category(entry.key)),
          const SizedBox(height: Insets.md),
          for (final widget in entry.value) ...[
            _WidgetCard(widget: widget),
            const SizedBox(height: Insets.sm),
          ],
          const SizedBox(height: Insets.lg),
        ],
      ],
    );
  }
}

/// The quick actions the server says this viewer may perform — each a shortcut
/// to a real operation. The server already authorized the list; tapping opens
/// the screen (which re-authorizes), or says so plainly when this build has no
/// screen for a newer action.
class _ActionsCard extends StatelessWidget {
  const _ActionsCard({required this.actions});

  final List<CommandAction> actions;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (final (index, action) in actions.indexed) ...[
            if (index > 0) const Divider(height: 1),
            _ActionRow(action: action),
          ],
        ],
      ),
    );
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({required this.action});

  final CommandAction action;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      key: Key('command-action-${action.id}'),
      leading: const Icon(Icons.bolt_outlined),
      title: Text(action.title),
      trailing: const Icon(Icons.chevron_left, size: 18),
      onTap: () {
        final route = routeForCommandAction(action.id);
        if (route == null) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text(CommandCenterCopy.actionUnavailable)),
          );
          return;
        }
        context.push(route);
      },
    );
  }
}

/// One widget: its title and its metric rows. A widget the server could resolve
/// no metric for says so plainly — never a fabricated zero.
class _WidgetCard extends StatelessWidget {
  const _WidgetCard({required this.widget});

  final CommandWidget widget;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(widget.title, style: context.text.titleMedium),
          const SizedBox(height: Insets.md),
          if (widget.metrics.isEmpty)
            Text(
              CommandCenterCopy.noData,
              style: context.text.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            )
          else
            for (final (index, metric) in widget.metrics.indexed) ...[
              if (index > 0) const SizedBox(height: Insets.sm),
              _MetricRow(metric: metric),
            ],
        ],
      ),
    );
  }
}

class _MetricRow extends StatelessWidget {
  const _MetricRow({required this.metric});

  final CommandMetric metric;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(
            metric.label,
            style: context.text.bodyMedium?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ),
        const SizedBox(width: Insets.md),
        Text(
          '${metric.value}',
          style: context.text.titleMedium?.copyWith(
            color: context.colors.primary,
            fontWeight: FontWeight.w700,
          ),
        ),
      ],
    );
  }
}

/// The loading state: a couple of placeholder cards, in the screen's own shape.
class _CommandCenterSkeleton extends StatelessWidget {
  const _CommandCenterSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SkeletonBox(height: 20, width: 120),
        SizedBox(height: Insets.md),
        SkeletonBox(height: 96),
        SizedBox(height: Insets.sm),
        SkeletonBox(height: 96),
      ],
    );
  }
}

/// A failed load, said in a word with a retry.
class _CommandCenterError extends StatelessWidget {
  const _CommandCenterError({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final code = error is ReportingException ? (error as ReportingException).code : null;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.cloud_off_rounded,
                size: 18,
                color: context.colors.onSurfaceVariant,
              ),
              const SizedBox(width: Insets.sm),
              Expanded(
                child: Text(
                  CommandCenterCopy.error(code),
                  style: context.text.bodyMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: Insets.md),
          Align(
            alignment: AlignmentDirectional.centerEnd,
            child: OutlinedButton(
              onPressed: onRetry,
              child: const Text(CommandCenterCopy.retry),
            ),
          ),
        ],
      ),
    );
  }
}
