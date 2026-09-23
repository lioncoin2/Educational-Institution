import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/realtime/realtime_client.dart';
import '../../../providers/app_providers.dart';

/// A thin strip while the live connection is being re-established.
///
/// Silent otherwise: a first connection takes a moment and needs no
/// announcement, and the demo build has no connection to speak of. Nothing
/// is lost while it shows — messages are stored on the server, and the
/// screen catches up when the connection returns.
class ConnectionBanner extends ConsumerWidget {
  const ConnectionBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(realtimeStatusProvider).value;
    if (status != RealtimeStatus.reconnecting) return const SizedBox.shrink();
    return Material(
      color: context.colors.surfaceContainerHigh,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: Insets.lg,
          vertical: Insets.xs,
        ),
        child: Row(
          children: [
            const SizedBox.square(
              dimension: 12,
              child: CircularProgressIndicator(strokeWidth: 1.5),
            ),
            const SizedBox(width: Insets.sm),
            Expanded(
              child: Text(
                'انقطع الاتصال — جارٍ إعادة الاتصال…',
                style: context.text.labelSmall,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
