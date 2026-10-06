import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/data/realtime/realtime_client.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/communities/community_copy.dart';
import 'package:quran_institution_app/features/communities/community_screen.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// The community screen's live-session entry is gated by the server's answer:
/// it appears if and only if the viewer may take part in live here
/// (`CommunityParticipation.liveJoin`). Navigation only — the community screen
/// never loads a session or touches live transport/media.
class _OneCommunity implements CommunityRepository {
  _OneCommunity(this._community);

  final Community _community;

  @override
  Future<Community> community(String communityId) async => _community;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

Community _community({required bool canJoinLive}) => Community(
  id: 'c-1',
  title: 'حلقة التجويد',
  status: CommunityStatus.open,
  lifecycleVersion: 1,
  memberCount: 3,
  createdAt: DateTime.utc(2026),
  me: CommunityMe(
    standing: CommunityStanding.member,
    joinedAt: DateTime.utc(2026),
    participation: canJoinLive
        ? const {CommunityParticipation.liveJoin}
        : const {},
  ),
);

void main() {
  Future<void> pump(WidgetTester tester, Community community) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          communityRepositoryProvider.overrideWithValue(
            _OneCommunity(community),
          ),
          realtimeConnectionProvider.overrideWithValue(
            const DisabledRealtimeClient(),
          ),
          sessionUserProvider.overrideWith((ref) async => null),
        ],
        child: const MaterialApp(home: CommunityScreen(communityId: 'c-1')),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('offers the live-session entry when the viewer may join live', (
    tester,
  ) async {
    await pump(tester, _community(canJoinLive: true));
    expect(find.text(CommunityCopy.viewLive), findsOneWidget);
  });

  testWidgets('hides the live-session entry when the viewer may not', (
    tester,
  ) async {
    await pump(tester, _community(canJoinLive: false));
    expect(find.text(CommunityCopy.viewLive), findsNothing);
  });
}
