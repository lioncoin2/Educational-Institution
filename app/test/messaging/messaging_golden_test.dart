@Tags(['golden'])
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/app.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_messaging_repository.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// Renders the REAL messaging screens (full app, demo data) to golden PNGs, with
/// the app's Arabic fonts loaded so the shaping is genuine. This is visual
/// evidence of the applied green/cream palette ([MessagingPalette]) — not a
/// hand-drawn mock. Regenerate with:
///   flutter test --update-goldens --tags golden test/messaging/messaging_golden_test.dart
///
/// Goldens are font/platform sensitive, so they are tagged and kept out of the
/// default run (see dart_test.yaml); they exist to produce and review the image,
/// not as a brittle CI gate.
Future<void> _loadFonts() async {
  const families = {
    'Almarai': [
      'assets/fonts/Almarai-Regular.ttf',
      'assets/fonts/Almarai-Bold.ttf',
      'assets/fonts/Almarai-ExtraBold.ttf',
    ],
    'PlexArabic': [
      'assets/fonts/IBMPlexSansArabic-Regular.ttf',
      'assets/fonts/IBMPlexSansArabic-Medium.ttf',
      'assets/fonts/IBMPlexSansArabic-SemiBold.ttf',
    ],
    'AmiriQuran': ['assets/fonts/AmiriQuran-Regular.ttf'],
  };
  for (final entry in families.entries) {
    final loader = FontLoader(entry.key);
    for (final path in entry.value) {
      loader.addFont(rootBundle.load(path));
    }
    await loader.load();
  }
  // Material icons are shipped by the SDK, not the app bundle; load them so the
  // rendered evidence shows real glyphs instead of placeholder boxes.
  final flutterRoot = Platform.environment['FLUTTER_ROOT'] ?? '/opt/flutter';
  final iconFile = File(
    '$flutterRoot/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
  );
  if (iconFile.existsSync()) {
    final loader = FontLoader('MaterialIcons')
      ..addFont(iconFile.readAsBytes().then((b) => ByteData.sublistView(b)));
    await loader.load();
  }
}

Future<void> _bootAt(WidgetTester tester, String route) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final container = ProviderContainer(
    overrides: [
      // Zero-latency mock so loading settles without a lingering spinner.
      messagingRepositoryProvider
          .overrideWithValue(MockMessagingRepository(latency: Duration.zero)),
    ],
  );
  addTearDown(container.dispose);

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: const QuranInstitutionApp(),
    ),
  );
  await tester.pump(const Duration(seconds: 3)); // the splash timer
  await tester.pumpAndSettle();
  container.read(routerProvider).go(route);
  // Fixed frames rather than pumpAndSettle: avoids hanging on any ambient
  // animation, while giving the zero-latency mock time to resolve.
  for (var i = 0; i < 30; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  setUpAll(_loadFonts);

  Future<void> golden(WidgetTester tester, String route, String name) async {
    await _bootAt(tester, route);
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('golden/$name.png'),
    );
  }

  testWidgets('community list', (tester) async {
    await golden(tester, '/communities', 'community_list');
  });

  testWidgets('community detail', (tester) async {
    await golden(
      tester,
      '/communities/mock-community-tajweed',
      'community_detail',
    );
  });

  testWidgets('community members', (tester) async {
    await golden(
      tester,
      '/communities/mock-community-family/members',
      'community_members',
    );
  });

  testWidgets('community invitations', (tester) async {
    await golden(
      tester,
      '/communities/mock-community-family/invitations',
      'community_invitations',
    );
  });

  testWidgets('messages list', (tester) async {
    await golden(tester, '/messages', 'messages_list');
  });

  testWidgets('group conversation (read-only member)', (tester) async {
    await golden(
      tester,
      '/messages/mock-community-tajweed-chat',
      'group_conversation',
    );
  });

  // An active group the viewer may post in: shows sent (green) AND received
  // bubbles plus the composer (text / voice / attach) — reference screen 2.
  testWidgets('group chat with sent and received bubbles', (tester) async {
    await golden(tester, '/messages/mock-group', 'group_chat_active');
  });

  testWidgets('channel conversation', (tester) async {
    await golden(tester, '/messages/mock-channel', 'channel_conversation');
  });

  testWidgets('bulk publish', (tester) async {
    await golden(tester, '/publish', 'bulk_publish');
  });
}
