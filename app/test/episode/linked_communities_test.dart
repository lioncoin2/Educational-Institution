import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:quran_institution_app/core/widgets/foundations/section_header.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/features/communities/state/community_list_controller.dart';
import 'package:quran_institution_app/features/episode/episode_screen.dart';

/// The halaqa detail screen's "linked communities" section (edit 1): it reuses
/// the existing Q50 association (each [Community] carries its `halaqaIds`) read
/// through the existing `communityListProvider` — no parallel link. It lists the
/// groups AND channels linked to THIS halaqa, excludes others, and disappears
/// when there is nothing to show.
Community _community(
  String id,
  String title,
  String chatMode,
  List<String> halaqaIds,
) => Community.fromJson({
  'id': id,
  'title': title,
  'status': 'OPEN',
  'lifecycleVersion': 1,
  'memberCount': 7,
  'createdAt': '2026-01-01T00:00:00.000Z',
  'me': {'standing': 'MEMBER'},
  'chatMode': chatMode,
  'halaqaIds': halaqaIds,
});

class _StubCommunityList extends CommunityListController {
  _StubCommunityList(this._items);

  final List<Community> _items;

  @override
  Future<CommunityListState> build() async => CommunityListState(items: _items);
}

Future<void> _pump(
  WidgetTester tester, {
  required List<Community> communities,
  String halaqaId = 'h1',
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        communityListProvider.overrideWith(
          () => _StubCommunityList(communities),
        ),
      ],
      child: MaterialApp(
        locale: const Locale('ar'),
        home: Scaffold(
          body: CustomScrollView(
            slivers: [LinkedHalaqaCommunities(halaqaId: halaqaId)],
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'lists the groups AND channels linked to this halaqa, not others',
    (tester) async {
      await _pump(
        tester,
        communities: [
          _community('c-group', 'كروب الحلقة', 'GROUP_OPEN', ['h1']),
          _community('c-channel', 'قناة الحلقة', 'CHANNEL', ['h1', 'h2']),
          _community('c-other', 'كروب حلقة أخرى', 'GROUP_OPEN', ['h2']),
          _community('c-none', 'كروب بلا حلقة', 'GROUP_RESTRICTED', const []),
        ],
      );

      expect(find.byType(SectionHeader), findsOneWidget);
      expect(find.text('المجتمعات المرتبطة'), findsOneWidget);
      // A linked GROUP and a linked CHANNEL both appear.
      expect(find.text('كروب الحلقة'), findsOneWidget);
      expect(find.text('قناة الحلقة'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('halaqa-community-c-group')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('halaqa-community-c-channel')),
        findsOneWidget,
      );
      // A community linked to a DIFFERENT halaqa, and an unlinked one, do not.
      expect(find.text('كروب حلقة أخرى'), findsNothing);
      expect(find.text('كروب بلا حلقة'), findsNothing);
    },
  );

  testWidgets('shows nothing when no community is linked to this halaqa', (
    tester,
  ) async {
    await _pump(
      tester,
      communities: [
        _community('c-other', 'كروب حلقة أخرى', 'GROUP_OPEN', ['h2']),
      ],
    );
    expect(find.byType(SectionHeader), findsNothing);
    expect(find.text('المجتمعات المرتبطة'), findsNothing);
  });

  testWidgets('shows nothing when the viewer has no communities', (
    tester,
  ) async {
    await _pump(tester, communities: const []);
    expect(find.text('المجتمعات المرتبطة'), findsNothing);
  });

  testWidgets(
    'excludes a community linked to this halaqa that the viewer is NOT a '
    'member of',
    (tester) async {
      // communityListProvider is the viewer's ACTIVE memberships only
      // (GET /communities?scope=mine → myCommunities(principal.userId)); a
      // community the viewer has not joined is simply absent from it. So a
      // non-member community linked to h1 ('c-nonmember') is never in the list
      // and can never render here — only the community the viewer belongs to.
      await _pump(
        tester,
        communities: [
          _community('c-member', 'كروب أنا عضو فيه', 'GROUP_OPEN', ['h1']),
        ],
      );
      expect(find.text('كروب أنا عضو فيه'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('halaqa-community-c-member')),
        findsOneWidget,
      );
      // The non-member linked community (absent from the memberships list):
      expect(find.text('كروب لست عضواً فيه'), findsNothing);
      expect(
        find.byKey(const ValueKey('halaqa-community-c-nonmember')),
        findsNothing,
      );
    },
  );
}
