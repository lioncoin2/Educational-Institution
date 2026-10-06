import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/async_view.dart';
import '../../../data/models/live.dart';
import '../live_copy.dart';

/// A failed read of the live session, said in words the person can act on: the
/// server's code through [LiveCopy.error], and a retry.
class LiveErrorView extends StatelessWidget {
  const LiveErrorView({super.key, required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final error = this.error;
    final said = LiveCopy.error(error is LiveException ? error.code : null);
    return Padding(
      padding: const EdgeInsets.all(Insets.xxl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.cloud_off_rounded,
            size: 40,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(height: Insets.md),
          Text(
            said,
            textAlign: TextAlign.center,
            style: context.text.titleMedium,
          ),
          const SizedBox(height: Insets.md),
          OutlinedButton(onPressed: onRetry, child: const Text(LiveCopy.retry)),
        ],
      ),
    );
  }
}

/// Grey blocks in the shape of the session card about to load.
class LiveSkeleton extends StatelessWidget {
  const LiveSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return const Column(
      children: [
        SkeletonBox(height: 120),
        SizedBox(height: Insets.md),
        SkeletonBox(height: 84),
      ],
    );
  }
}
