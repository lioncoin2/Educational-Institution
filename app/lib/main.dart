import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import 'app/app.dart';
import 'app/invite_link.dart';
import 'app/url_strategy.dart';
import 'features/communities/state/pending_invitation.dart';

void main() {
  configureUrlStrategy();
  // Both before runApp: building the router rewrites the address bar
  // without its fragment — the token of an invitation link — and registers
  // the engine's popstate listener, which must come after ours.
  final atStartup = takeInviteToken();
  final later = StreamController<String>.broadcast();
  listenForInviteTokens(later.add);
  runApp(
    ProviderScope(
      overrides: invitationOverrides(atStartup: atStartup, later: later.stream),
      child: const QuranInstitutionApp(),
    ),
  );
}

/// How the app is handed its invitation links: the token of the one the
/// page was opened with, if any, and the tokens of those opened later.
List<Override> invitationOverrides({
  required String? atStartup,
  required Stream<String> later,
}) => [
  startupInvitationTokenProvider.overrideWithValue(atStartup),
  laterInvitationTokensProvider.overrideWithValue(later),
];
