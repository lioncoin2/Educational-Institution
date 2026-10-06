import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:quran_institution_app/core/widgets/foundations/async_view.dart';
import 'package:quran_institution_app/core/widgets/foundations/mock_ribbon.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/attendance/attendance_copy.dart';
import 'package:quran_institution_app/features/attendance/snapshots_screen.dart';
import 'package:quran_institution_app/features/attendance/widgets/snapshot_views.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

SnapshotView _snap(String id, {DataOrigin origin = DataOrigin.records}) =>
    SnapshotView(
      id: id,
      communityId: 'c-1',
      liveSessionId: 's-1',
      recordedBy: const SnapshotRecorder(userId: 'u-1', displayName: 'أم أحمد'),
      observationRule: 'provider_registry_v1',
      observationStartedAt: DateTime.utc(2026),
      observedAt: DateTime.utc(2026),
      recordedAt: DateTime.utc(2026),
      connectedCount: 3,
      connectingCount: 1,
      origin: origin,
    );

class _ViewRepo implements AttendanceRepository {
  _ViewRepo(this._snapshots);

  final Future<SnapshotPage> Function(String? cursor) _snapshots;

  @override
  Future<SnapshotPage> snapshots(
    String communityId, {
    String? liveSessionId,
    String? cursor,
  }) => _snapshots(cursor);

  @override
  Future<SnapshotView> record(
    String liveSessionId, {
    required String clientRequestId,
  }) => throw UnimplementedError();

  @override
  Future<SnapshotView> snapshot(String snapshotId) =>
      throw UnimplementedError();

  @override
  Future<SnapshotParticipantPage> participants(
    String snapshotId, {
    SnapshotConnection? connection,
    String? cursor,
  }) => throw UnimplementedError();
}

void main() {
  Future<void> pump(WidgetTester tester, _ViewRepo repo) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attendanceRepositoryProvider.overrideWithValue(repo),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: const MaterialApp(
          home: AttendanceSnapshotsScreen(communityId: 'c-1'),
        ),
      ),
    );
  }

  testWidgets('shows a skeleton while loading', (tester) async {
    final hold = Completer<SnapshotPage>();
    await pump(tester, _ViewRepo((_) => hold.future));
    await tester.pump();
    expect(find.byType(SkeletonBox), findsWidgets);
    hold.complete(const SnapshotPage(items: []));
    await tester.pumpAndSettle();
  });

  testWidgets('shows the empty state when there are no snapshots', (
    tester,
  ) async {
    await pump(tester, _ViewRepo((_) async => const SnapshotPage(items: [])));
    await tester.pumpAndSettle();
    expect(find.text(AttendanceCopy.snapshotsEmpty), findsOneWidget);
    expect(find.byType(SnapshotTile), findsNothing);
  });

  testWidgets('explains a failure and offers a retry', (tester) async {
    await pump(
      tester,
      _ViewRepo(
        (_) async => throw const AttendanceException(
          'attendance.community_not_found',
          'no',
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.text(AttendanceCopy.error('attendance.community_not_found')),
      findsOneWidget,
    );
    expect(find.text(AttendanceCopy.retry), findsOneWidget);
  });

  testWidgets('lists the snapshots', (tester) async {
    await pump(
      tester,
      _ViewRepo((_) async => SnapshotPage(items: [_snap('a'), _snap('b')])),
    );
    await tester.pumpAndSettle();
    expect(find.byType(SnapshotTile), findsNWidgets(2));
    // A count, never a verdict.
    expect(find.textContaining('حاضر'), findsNothing);
  });

  testWidgets('flags demo data and loads more on request', (tester) async {
    await pump(
      tester,
      _ViewRepo((cursor) async {
        if (cursor == null) {
          return SnapshotPage(
            items: [_snap('a', origin: DataOrigin.mock)],
            nextCursor: 'c2',
          );
        }
        return SnapshotPage(items: [_snap('b', origin: DataOrigin.mock)]);
      }),
    );
    await tester.pumpAndSettle();
    expect(find.byType(MockBanner), findsOneWidget);
    expect(find.byType(SnapshotTile), findsOneWidget);

    await tester.tap(find.text(AttendanceCopy.loadMore));
    await tester.pumpAndSettle();
    expect(find.byType(SnapshotTile), findsNWidgets(2));
    expect(find.text(AttendanceCopy.loadMore), findsNothing);
  });

  testWidgets('tapping a snapshot navigates to its detail route', (
    tester,
  ) async {
    final router = GoRouter(
      initialLocation: '/communities/c-1/attendance/snapshots',
      routes: [
        GoRoute(
          path: '/communities/:cid/attendance/snapshots',
          builder: (context, state) => AttendanceSnapshotsScreen(
            communityId: state.pathParameters['cid']!,
          ),
          routes: [
            GoRoute(
              path: ':sid',
              builder: (context, state) =>
                  Scaffold(body: Text('DETAIL ${state.pathParameters['sid']}')),
            ),
          ],
        ),
      ],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attendanceRepositoryProvider.overrideWithValue(
            _ViewRepo((_) async => SnapshotPage(items: [_snap('snap-7')])),
          ),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(SnapshotTile).first);
    await tester.pumpAndSettle();
    expect(find.text('DETAIL snap-7'), findsOneWidget);
  });
}
