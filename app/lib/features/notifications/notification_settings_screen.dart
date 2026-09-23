import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../data/models/notifications.dart';
import '../../providers/app_providers.dart';
import 'notification_copy.dart';
import 'state/notification_preferences_controller.dart';

/// إعدادات الإشعارات — per category, the three channels, each its own
/// switch. Turning one off never turns another off; turning "in the app" off
/// means nothing is kept, so the other two have nothing to deliver, and the
/// screen says so rather than hiding it.
class NotificationSettingsScreen extends ConsumerWidget {
  const NotificationSettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final preferences = ref.watch(notificationPreferencesProvider);
    final pushAvailable = ref.watch(pushTokenSourceProvider).isAvailable;
    return Scaffold(
      appBar: AppBar(title: const Text(NotificationCopy.settingsTitle)),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: preferences,
          onRetry: () => ref.invalidate(notificationPreferencesProvider),
          builder: (context, categories) => CustomScrollView(
            slivers: [
              for (final category in categories) ...[
                SliverGutter(
                  top: Insets.xxl,
                  child: SectionHeader(
                    title: NotificationCopy.category(category.category),
                  ),
                ),
                SliverGutter(
                  top: Insets.lg,
                  child: _CategoryCard(
                    preferences: category,
                    pushAvailable: pushAvailable,
                  ),
                ),
              ],
              const SliverGutter(top: Insets.giant, child: SizedBox.shrink()),
            ],
          ),
        ),
      ),
    );
  }
}

class _CategoryCard extends ConsumerWidget {
  const _CategoryCard({required this.preferences, required this.pushAvailable});

  final ChannelPreferences preferences;
  final bool pushAvailable;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    Future<void> change({bool? inApp, bool? realtime, bool? push}) async {
      try {
        await ref
            .read(notificationPreferencesProvider.notifier)
            .change(
              preferences.category,
              inApp: inApp,
              realtime: realtime,
              push: push,
            );
      } on NotificationsException {
        if (!context.mounted) return;
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(
            const SnackBar(content: Text(NotificationCopy.saveFailed)),
          );
      }
    }

    final stored = preferences.inApp;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Switch(
            label: NotificationCopy.inApp,
            hint: NotificationCopy.inAppHint,
            value: preferences.inApp,
            onChanged: (value) => unawaited(change(inApp: value)),
          ),
          const Divider(),
          _Switch(
            label: NotificationCopy.realtime,
            hint: NotificationCopy.realtimeHint,
            value: preferences.realtime,
            // Kept as set, but it has nothing to deliver while nothing is kept.
            enabled: stored,
            onChanged: (value) => unawaited(change(realtime: value)),
          ),
          const Divider(),
          _Switch(
            label: NotificationCopy.push,
            hint: NotificationCopy.pushHint,
            value: preferences.push,
            enabled: stored,
            onChanged: (value) => unawaited(change(push: value)),
          ),
          if (!stored || !pushAvailable) ...[
            const SizedBox(height: Insets.md),
            Text(
              !stored
                  ? NotificationCopy.needsInApp
                  : NotificationCopy.pushUnavailable,
              style: context.text.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Switch extends StatelessWidget {
  const _Switch({
    required this.label,
    required this.hint,
    required this.value,
    required this.onChanged,
    this.enabled = true,
  });

  final String label;
  final String hint;
  final bool value;
  final bool enabled;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SwitchListTile.adaptive(
      contentPadding: EdgeInsets.zero,
      value: value,
      onChanged: enabled ? onChanged : null,
      title: Text(label, style: context.text.titleSmall),
      subtitle: Text(hint, style: context.text.bodySmall),
    );
  }
}
