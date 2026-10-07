import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/core/widgets/foundations/async_view.dart';
import 'package:quran_institution_app/core/widgets/foundations/mock_ribbon.dart';
import 'package:quran_institution_app/data/models/attendance.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/attendance/attendance_copy.dart';
import 'package:quran_institution_app/features/attendance/record_attendance_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

class _FakeLive implements LiveRepository {
  _FakeLive(this._answer);

  final Future<LiveSession?> Function(String communityId) _answer;

  @override
  Future<LiveSession?> currentSession(String communityId) =>
      _answer(communityId);

  // Session-by-id and the moderators' hand queue are not exercised here.
  @override
  Future<LiveSession> getSession(String sessionId) =>
      throw UnimplementedError();

  @override
  Future<LiveHandsPage> hands(
    String sessionId, {
    LiveHandsFilter? state,
    String? cursor,
    int? limit,
  }) => throw UnimplementedError();
}

/// A community that answers any id with a fixed `me`, so the screen's capability
/// read can be controlled without the full mock seed.
class _CommunityAnswering extends MockCommunityRepository {
  _CommunityAnswering(this._me) : super(latency: Duration.zero);

  final CommunityMe _me;

  @override
  Future<Community> community(String communityId) async => Community(
    id: communityId,
    title: 'مجتمع',
    status: CommunityStatus.open,
    lifecycleVersion: 1,
    memberCount: 3,
    createdAt: DateTime.utc(2026),
    me: _me,
  );
}

class _FakeAttendance implements AttendanceRepository {
  _FakeAttendance(this._answer);

  final Future<SnapshotView> Function() _answer;

  @override
  Future<SnapshotView> record(
    String liveSessionId, {
    required String clientRequestId,
  }) => _answer();

  // Viewing methods are not exercised by the record screen.
  @override
  Future<SnapshotPage> snapshots(
    String communityId, {
    String? liveSessionId,
    String? cursor,
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

LiveSession _session({
  bool canModerate = false,
  LiveSessionState state = LiveSessionState.live,
  DataOrigin origin = DataOrigin.records,
}) => LiveSession(
  id: 's-1',
  communityId: 'c-1',
  state: state,
  hostUserId: 'u-host',
  startedAt: DateTime.utc(2026),
  speakerCount: 2,
  me: LiveMe(
    role: LiveParticipantRole.listener,
    isHost: canModerate,
    canModerate: canModerate,
  ),
  origin: origin,
);

SnapshotView _snapshot() => SnapshotView(
  id: 'snap-1',
  communityId: 'c-1',
  liveSessionId: 's-1',
  recordedBy: const SnapshotRecorder(userId: 'u-1', displayName: 'أم أحمد'),
  observationRule: 'provider_registry_v1',
  observationStartedAt: DateTime.utc(2026),
  observedAt: DateTime.utc(2026),
  recordedAt: DateTime.utc(2026),
  connectedCount: 12,
  connectingCount: 2,
  origin: DataOrigin.records,
);

const _recorderMe = CommunityMe(
  standing: CommunityStanding.member,
  capabilities: {CommunityCapability.attendanceRecord},
);
const _plainMe = CommunityMe(standing: CommunityStanding.member);

void main() {
  Future<void> pump(
    WidgetTester tester, {
    required Future<LiveSession?> Function(String) live,
    CommunityMe communityMe = _plainMe,
    AttendanceRepository? attendance,
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          liveRepositoryProvider.overrideWithValue(_FakeLive(live)),
          communityRepositoryProvider.overrideWithValue(
            _CommunityAnswering(communityMe),
          ),
          attendanceRepositoryProvider.overrideWithValue(
            attendance ?? _FakeAttendance(() async => _snapshot()),
          ),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: const MaterialApp(
          home: RecordAttendanceScreen(communityId: 'c-1'),
        ),
      ),
    );
  }

  testWidgets('shows a skeleton while the session loads', (tester) async {
    final hold = Completer<LiveSession?>();
    await pump(tester, live: (_) => hold.future);
    await tester.pump();
    expect(find.byType(SkeletonBox), findsWidgets);

    hold.complete(_session(canModerate: true));
    await tester.pumpAndSettle();
    expect(find.byType(SkeletonBox), findsNothing);
  });

  testWidgets('shows the empty state when no session is running', (
    tester,
  ) async {
    await pump(tester, live: (_) async => null);
    await tester.pumpAndSettle();
    expect(find.text(AttendanceCopy.noSession), findsOneWidget);
    expect(find.text(AttendanceCopy.recordButton), findsNothing);
  });

  testWidgets('says the session is not running when it is not live', (
    tester,
  ) async {
    await pump(
      tester,
      live: (_) async => _session(state: LiveSessionState.ended),
    );
    await tester.pumpAndSettle();
    expect(find.text(AttendanceCopy.sessionNotLive), findsOneWidget);
    expect(find.text(AttendanceCopy.recordButton), findsNothing);
  });

  testWidgets(
    'offers no record when the viewer may neither record nor moderate',
    (tester) async {
      await pump(tester, live: (_) async => _session());
      await tester.pumpAndSettle();
      expect(find.text(AttendanceCopy.cannotRecordMessage), findsOneWidget);
      expect(find.text(AttendanceCopy.recordButton), findsNothing);
    },
  );

  testWidgets('shows the record button for a holder of the record capability', (
    tester,
  ) async {
    await pump(tester, live: (_) async => _session(), communityMe: _recorderMe);
    await tester.pumpAndSettle();
    expect(find.text(AttendanceCopy.recordButton), findsOneWidget);
  });

  testWidgets('shows the record button for a session moderator', (
    tester,
  ) async {
    await pump(tester, live: (_) async => _session(canModerate: true));
    await tester.pumpAndSettle();
    expect(find.text(AttendanceCopy.recordButton), findsOneWidget);
  });

  testWidgets('disables the button in flight, then shows the counts', (
    tester,
  ) async {
    final hold = Completer<SnapshotView>();
    await pump(
      tester,
      live: (_) async => _session(canModerate: true),
      attendance: _FakeAttendance(() => hold.future),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text(AttendanceCopy.recordButton));
    await tester.pump();
    expect(find.text(AttendanceCopy.recording), findsOneWidget);
    final button = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, AttendanceCopy.recording),
    );
    expect(button.onPressed, isNull); // disabled while in flight

    hold.complete(_snapshot());
    await tester.pumpAndSettle();
    expect(find.text(AttendanceCopy.connected(12)), findsOneWidget);
    expect(find.text(AttendanceCopy.connecting(2)), findsOneWidget);
    // Never a presence verdict.
    expect(find.textContaining('حاضر'), findsNothing);
  });

  testWidgets('explains a failure and offers a retry', (tester) async {
    await pump(
      tester,
      live: (_) async => _session(canModerate: true),
      attendance: _FakeAttendance(
        () async => throw const AttendanceException(
          'attendance.observation_unavailable',
          'no',
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text(AttendanceCopy.recordButton));
    await tester.pumpAndSettle();
    expect(
      find.text(AttendanceCopy.error('attendance.observation_unavailable')),
      findsOneWidget,
    );
    expect(find.text(AttendanceCopy.retry), findsOneWidget);
  });

  testWidgets('flags a demo session as mock data', (tester) async {
    await pump(
      tester,
      live: (_) async => _session(canModerate: true, origin: DataOrigin.mock),
    );
    await tester.pumpAndSettle();
    expect(find.byType(MockBanner), findsOneWidget);
  });
}
