import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/core/widgets/foundations/async_view.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/attendance/attendance_copy.dart';
import 'package:quran_institution_app/features/attendance/snapshot_detail_screen.dart';
import 'package:quran_institution_app/features/attendance/widgets/snapshot_views.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

SnapshotView _snap({int connected = 12, int connecting = 2}) => SnapshotView(
  id: 's-1',
  communityId: 'c-1',
  liveSessionId: 'live-1',
  recordedBy: const SnapshotRecorder(userId: 'u-1', displayName: 'أم أحمد'),
  observationRule: 'provider_registry_v1',
  observationStartedAt: DateTime.utc(2026),
  observedAt: DateTime.utc(2026),
  recordedAt: DateTime.utc(2026),
  connectedCount: connected,
  connectingCount: connecting,
  origin: DataOrigin.records,
);

SnapshotParticipant _p(String id, SnapshotConnection c) => SnapshotParticipant(
  userId: id,
  displayName: 'مشارك $id',
  connection: c,
  origin: DataOrigin.records,
);

class _DetailRepo implements AttendanceRepository {
  _DetailRepo({required this.header, required this.participantsAnswer});

  final Future<SnapshotView> Function() header;
  final Future<SnapshotParticipantPage> Function(String? cursor)
  participantsAnswer;

  @override
  Future<SnapshotView> snapshot(String snapshotId) => header();

  @override
  Future<SnapshotParticipantPage> participants(
    String snapshotId, {
    SnapshotConnection? connection,
    String? cursor,
  }) => participantsAnswer(cursor);

  @override
  Future<SnapshotView> record(
    String liveSessionId, {
    required String clientRequestId,
  }) => throw UnimplementedError();

  @override
  Future<SnapshotPage> snapshots(
    String communityId, {
    String? liveSessionId,
    String? cursor,
  }) => throw UnimplementedError();
}

void main() {
  Future<void> pump(WidgetTester tester, _DetailRepo repo) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attendanceRepositoryProvider.overrideWithValue(repo),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: const MaterialApp(
          home: AttendanceSnapshotDetailScreen(snapshotId: 's-1'),
        ),
      ),
    );
  }

  testWidgets('shows a skeleton while the header loads', (tester) async {
    final hold = Completer<SnapshotView>();
    await pump(
      tester,
      _DetailRepo(
        header: () => hold.future,
        participantsAnswer: (_) async =>
            const SnapshotParticipantPage(items: []),
      ),
    );
    await tester.pump();
    expect(find.byType(SkeletonBox), findsWidgets);
    hold.complete(_snap());
    await tester.pumpAndSettle();
  });

  testWidgets('shows the header counts and the participants', (tester) async {
    await pump(
      tester,
      _DetailRepo(
        header: () async => _snap(connected: 12, connecting: 2),
        participantsAnswer: (_) async => SnapshotParticipantPage(
          items: [
            _p('u-1', SnapshotConnection.connected),
            _p('u-2', SnapshotConnection.connecting),
          ],
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text(AttendanceCopy.connected(12)), findsOneWidget);
    expect(find.text(AttendanceCopy.connecting(2)), findsOneWidget);
    expect(find.byType(ParticipantTile), findsNWidgets(2));
    // Per-row connection words, never a presence verdict.
    expect(
      find.text(AttendanceCopy.connectionState(SnapshotConnection.connected)),
      findsOneWidget,
    );
    expect(
      find.text(AttendanceCopy.connectionState(SnapshotConnection.connecting)),
      findsOneWidget,
    );
    expect(find.textContaining('حاضر'), findsNothing);
  });

  testWidgets('shows the empty participants state', (tester) async {
    await pump(
      tester,
      _DetailRepo(
        header: () async => _snap(),
        participantsAnswer: (_) async =>
            const SnapshotParticipantPage(items: []),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text(AttendanceCopy.participantsEmpty), findsOneWidget);
    expect(find.byType(ParticipantTile), findsNothing);
  });

  testWidgets('loads more participants on request', (tester) async {
    await pump(
      tester,
      _DetailRepo(
        header: () async => _snap(),
        participantsAnswer: (cursor) async => cursor == null
            ? SnapshotParticipantPage(
                items: [_p('u-1', SnapshotConnection.connected)],
                nextCursor: 'p2',
              )
            : SnapshotParticipantPage(
                items: [_p('u-2', SnapshotConnection.connected)],
              ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(ParticipantTile), findsOneWidget);
    await tester.tap(find.text(AttendanceCopy.loadMore));
    await tester.pumpAndSettle();
    expect(find.byType(ParticipantTile), findsNWidgets(2));
  });

  testWidgets('explains a header refusal (404) with a retry', (tester) async {
    await pump(
      tester,
      _DetailRepo(
        header: () async => throw const AttendanceException(
          'attendance.snapshot_not_found',
          'no',
        ),
        participantsAnswer: (_) async =>
            const SnapshotParticipantPage(items: []),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.text(AttendanceCopy.error('attendance.snapshot_not_found')),
      findsOneWidget,
    );
  });
}
