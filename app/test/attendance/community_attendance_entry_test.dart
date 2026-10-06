import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_community_repository.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/community_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The community screen's attendance doorway: navigation only, shown when the
/// server says the viewer may record here (the record capability, or a session
/// moderator's), hidden otherwise. The button is matched by its type so the
/// capability pill (which can carry the same words) never stands in for it.
class _CommunityAnswering extends MockCommunityRepository {
  _CommunityAnswering(this._me) : super(latency: Duration.zero);

  final CommunityMe _me;

  @override
  Future<Community> community(String communityId) async => Community(
    id: communityId,
    title: 'مجتمع الاختبار',
    status: CommunityStatus.open,
    lifecycleVersion: 1,
    memberCount: 3,
    createdAt: DateTime.utc(2026),
    me: _me,
  );
}

void main() {
  Future<void> pumpCommunity(WidgetTester tester, CommunityMe me) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          communityRepositoryProvider.overrideWithValue(
            _CommunityAnswering(me),
          ),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: const MaterialApp(home: CommunityScreen(communityId: 'c-1')),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder attendanceEntry() =>
      find.widgetWithText(OutlinedButton, CommunityCopy.openAttendance);

  // The viewing doorway (the snapshots history), matched by its button so the
  // `attendanceView` capability pill never stands in for it.
  Finder viewEntry() =>
      find.widgetWithText(OutlinedButton, CommunityCopy.viewAttendance);

  testWidgets('shows the entry when the viewer holds the record capability', (
    tester,
  ) async {
    await pumpCommunity(
      tester,
      const CommunityMe(
        standing: CommunityStanding.member,
        capabilities: {CommunityCapability.attendanceRecord},
      ),
    );
    expect(attendanceEntry(), findsOneWidget);
  });

  testWidgets('shows the entry for a session moderator (liveModerate)', (
    tester,
  ) async {
    await pumpCommunity(
      tester,
      const CommunityMe(
        standing: CommunityStanding.member,
        capabilities: {CommunityCapability.liveModerate},
      ),
    );
    expect(attendanceEntry(), findsOneWidget);
  });

  testWidgets(
    'hides the entry when the viewer may neither record nor moderate',
    (tester) async {
      await pumpCommunity(
        tester,
        const CommunityMe(standing: CommunityStanding.member),
      );
      // The screen rendered (so the absence below is real, not an error page).
      expect(find.text('مجتمع الاختبار'), findsWidgets);
      expect(attendanceEntry(), findsNothing);
      expect(viewEntry(), findsNothing);
    },
  );

  testWidgets(
    'shows the viewing entry when the viewer holds the view capability',
    (tester) async {
      await pumpCommunity(
        tester,
        const CommunityMe(
          standing: CommunityStanding.member,
          capabilities: {CommunityCapability.attendanceView},
        ),
      );
      expect(viewEntry(), findsOneWidget);
      // View-only: no record doorway.
      expect(attendanceEntry(), findsNothing);
    },
  );

  testWidgets('hides the viewing entry without the view capability', (
    tester,
  ) async {
    await pumpCommunity(
      tester,
      const CommunityMe(
        standing: CommunityStanding.member,
        capabilities: {CommunityCapability.attendanceRecord},
      ),
    );
    expect(viewEntry(), findsNothing);
  });
}
