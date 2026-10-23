import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/features/communities/state/community_controller.dart';
import 'package:quran_institution_app/features/communities/widgets/community_tile.dart';

import 'community_test_support.dart';

/// The community card shows the community's own picture (its avatar), resolved
/// through the existing signed-link provider, before the viewer opens it —
/// falling back to the initial when there is no picture (Requirement B).
void main() {
  Community community({String id = 'c1', String? avatar}) =>
      Community.fromJson({
        ...communityJson(id: id, title: 'حلقة التجويد'),
        'avatarFileAssetId': avatar,
      });

  Future<void> pumpTile(
    WidgetTester tester,
    Community c, {
    List<Override> overrides = const [],
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: overrides,
        child: MaterialApp(
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: Scaffold(
              body: CommunityTile(community: c, onTap: () {}),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('shows the community picture when it has one', (tester) async {
    await pumpTile(
      tester,
      community(avatar: 'asset-1'),
      overrides: [
        communityAvatarUrlProvider(
          'c1',
        ).overrideWith((ref) async => Uri.parse('https://example.org/a.png')),
      ],
    );
    // The avatar image branch is taken (a ClipOval wrapping the network image),
    // not the initials-only fallback.
    expect(find.byType(ClipOval), findsOneWidget);
  });

  testWidgets('falls back to the initial when there is no picture', (
    tester,
  ) async {
    await pumpTile(tester, community(avatar: null));
    expect(find.byType(ClipOval), findsNothing);
    expect(find.text('ح'), findsOneWidget); // first letter of «حلقة التجويد»
  });

  testWidgets('a picture-less community makes no avatar request', (
    tester,
  ) async {
    var calls = 0;
    await pumpTile(
      tester,
      community(avatar: null),
      overrides: [
        communityAvatarUrlProvider('c1').overrideWith((ref) async {
          calls++;
          return null;
        }),
      ],
    );
    expect(calls, 0); // gated on avatarFileAssetId != null — no 404 request
  });
}
