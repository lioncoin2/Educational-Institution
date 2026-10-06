import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../data/models/attendance.dart';
import '../attendance_copy.dart';

/// One snapshot in the community's history: when it was taken, the two
/// connection counts, and who recorded it — facts only, never a verdict or a
/// ratio. Tapping it opens the participants.
class SnapshotTile extends StatelessWidget {
  const SnapshotTile({super.key, required this.snapshot, required this.onTap});

  final SnapshotView snapshot;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  AttendanceCopy.date(context, snapshot.recordedAt),
                  style: context.text.titleSmall,
                ),
                const SizedBox(height: Insets.xs),
                Text(
                  '${AttendanceCopy.connected(snapshot.connectedCount)}'
                  '  ·  '
                  '${AttendanceCopy.connecting(snapshot.connectingCount)}',
                  style: context.text.bodyMedium,
                ),
                const SizedBox(height: Insets.xs),
                Text(
                  AttendanceCopy.recordedBy(snapshot.recordedBy.displayName),
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          Icon(
            Icons.chevron_left_rounded,
            color: context.colors.onSurfaceVariant,
          ),
        ],
      ),
    );
  }
}

/// A snapshot's header on its detail screen: when, the two counts, and who
/// recorded it. A historical header — never the "recorded just now" framing of
/// the record result.
class SnapshotHeaderCard extends StatelessWidget {
  const SnapshotHeaderCard({super.key, required this.snapshot});

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
              Expanded(
                child: Text(
                  AttendanceCopy.date(context, snapshot.recordedAt),
                  style: context.text.titleMedium,
                ),
              ),
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

/// One participant on a snapshot's detail: the name the server resolved (a
/// neutral fallback when it did not, never the account id), and how the
/// provider held them — connected or connecting, never present or absent.
class ParticipantTile extends StatelessWidget {
  const ParticipantTile({super.key, required this.participant});

  final SnapshotParticipant participant;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Row(
        children: [
          Expanded(
            child: Text(
              participant.displayName ?? AttendanceCopy.unknownName,
              style: context.text.bodyLarge,
            ),
          ),
          const SizedBox(width: Insets.sm),
          Text(
            AttendanceCopy.connectionState(participant.connection),
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

/// The end of what is loaded: more to load, loading, or a retry — the Members
/// pagination footer, for attendance's immutable lists.
class LoadMoreFooter extends StatelessWidget {
  const LoadMoreFooter({
    super.key,
    required this.hasMore,
    required this.loadingMore,
    required this.loadMoreFailed,
    required this.onLoadMore,
  });

  final bool hasMore;
  final bool loadingMore;
  final bool loadMoreFailed;
  final VoidCallback onLoadMore;

  @override
  Widget build(BuildContext context) {
    if (!hasMore) return const SizedBox.shrink();
    if (loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return Center(
      child: TextButton(
        onPressed: onLoadMore,
        child: Text(
          loadMoreFailed
              ? AttendanceCopy.loadMoreFailed
              : AttendanceCopy.loadMore,
        ),
      ),
    );
  }
}
