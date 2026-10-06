import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../data/models/attendance.dart';
import '../attendance_copy.dart';

/// A failed record, said in words the person can act on: the server's code
/// through [AttendanceCopy.error], and a retry (which reuses the same key, so
/// it is this press again — never a second observation unless the first stored
/// nothing).
class AttendanceErrorView extends StatelessWidget {
  const AttendanceErrorView({
    super.key,
    required this.code,
    required this.onRetry,
  });

  final String? code;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
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
            AttendanceCopy.error(code),
            textAlign: TextAlign.center,
            style: context.text.titleMedium,
          ),
          const SizedBox(height: Insets.md),
          OutlinedButton(
            onPressed: onRetry,
            child: const Text(AttendanceCopy.retry),
          ),
        ],
      ),
    );
  }
}

/// The snapshot a press took: the two connection counts and who recorded it —
/// connections, never a presence verdict or a ratio (attendance.md §12).
class RecordResultCard extends StatelessWidget {
  const RecordResultCard({super.key, required this.snapshot});

  final SnapshotView snapshot;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.fact_check_outlined,
                size: 20,
                color: context.colors.primary,
              ),
              const SizedBox(width: Insets.sm),
              Text(AttendanceCopy.resultTitle, style: context.text.titleMedium),
            ],
          ),
          const SizedBox(height: Insets.md),
          Text(
            AttendanceCopy.connected(snapshot.connectedCount),
            style: context.text.bodyLarge,
          ),
          const SizedBox(height: Insets.xs),
          Text(
            AttendanceCopy.connecting(snapshot.connectingCount),
            style: context.text.bodyMedium?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: Insets.sm),
          Text(
            AttendanceCopy.recordedBy(snapshot.recordedBy.displayName),
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
