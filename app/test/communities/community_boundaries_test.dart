import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/communities.dart';
import 'package:quran_institution_app/features/communities/state/pending_invitation.dart';

/// The shape of communities in the app, asserted on the source:
///
///   screens → community state → CommunityRepository → HTTP (the server)
///                                                   → the demo's mock
///
///   - no community screen, widget or state reaches HTTP, the socket, the
///     API client or a repository implementation: only the contracts, the
///     providers, and the live connection as an abstraction;
///   - what someone may do IN a community is the server's `me`; the one
///     institution-level action — creating a community, which has no `me`
///     yet — is gated on the identity permission `communities.create` (as
///     messaging gates its start-a-conversation permissions), and nothing
///     here reads any other account permission or role;
///   - only the provider wiring decides which implementation runs;
///   - the real repository makes exactly the calls listed here, and adds
///     nobody by id;
///   - the community wire models are plain Dart;
///   - web-only code stays in lib/app, out of the features;
///   - an invitation token is never logged, and never printed;
///   - the screens are right-to-left safe: no hard-coded left or right;
///   - what the screens say lives in one place (community_copy.dart).
void main() {
  final sources = {
    for (final file
        in Directory('lib')
            .listSync(recursive: true)
            .whereType<File>()
            .where((f) => f.path.endsWith('.dart')))
      file.path.replaceAll(r'\', '/'): file.readAsStringSync(),
  };
  final imports = {
    for (final MapEntry(key: path, value: text) in sources.entries)
      path: RegExp(
        r'''^(?:import|export)\s+['"]([^'"]+)['"]''',
        multiLine: true,
      ).allMatches(text).map((m) => m.group(1)!).toList(),
  };
  final community = [
    for (final path in sources.keys)
      if (path.startsWith('lib/features/communities/')) path,
  ];

  test('reads the source tree (so the checks below are not vacuous)', () {
    for (final path in [
      'lib/data/models/communities.dart',
      'lib/data/repositories/http/http_community_repository.dart',
      'lib/data/repositories/mock/mock_community_repository.dart',
      'lib/features/communities/community_copy.dart',
      'lib/features/communities/communities_screen.dart',
      'lib/features/communities/community_screen.dart',
      'lib/features/communities/community_members_screen.dart',
      'lib/features/communities/state/community_list_controller.dart',
      'lib/features/communities/state/community_controller.dart',
      'lib/features/communities/state/community_members_controller.dart',
      'lib/features/communities/state/community_chat_opener.dart',
      'lib/features/communities/state/pending_invitation.dart',
      'lib/features/communities/community_invitations_screen.dart',
      'lib/features/communities/invite_screen.dart',
      'lib/features/communities/state/community_write.dart',
      'lib/features/communities/state/community_reconcile.dart',
      'lib/features/communities/state/community_invitations_controller.dart',
      'lib/features/communities/state/member_grants_controller.dart',
      'lib/features/communities/state/invitation_join_controller.dart',
      'lib/features/communities/widgets/community_change.dart',
      'lib/features/communities/widgets/invitation_tile.dart',
      'lib/features/communities/widgets/member_capabilities_sheet.dart',
      'lib/features/communities/widgets/one_time_link_sheet.dart',
      'lib/app/invite_link.dart',
      'lib/app/invite_link_parts.dart',
      'lib/app/invite_link_stub.dart',
      'lib/app/invite_link_web.dart',
      'lib/main.dart',
    ]) {
      expect(sources.keys, contains(path));
    }
    expect(community.length, greaterThanOrEqualTo(24));
  });

  test(
    'keeps community screens, widgets and state away from every transport',
    () {
      final offenders = [
        for (final path in community)
          for (final uri in imports[path]!)
            if (uri.startsWith('package:http') ||
                uri.startsWith('package:web_socket') ||
                uri == 'dart:io' ||
                uri == 'dart:html' ||
                uri.endsWith('api_client.dart') ||
                uri.endsWith('websocket_realtime_client.dart') ||
                uri.contains('/repositories/http/') ||
                uri.contains('/repositories/mock/') ||
                uri.contains('/repositories/academic/'))
              '$path → $uri',
      ];
      expect(offenders, isEmpty);
    },
  );

  test('knows the live connection only as its abstraction and its frames', () {
    final realtime = {
      for (final path in community)
        for (final uri in imports[path]!)
          if (uri.contains('data/realtime/')) uri.split('/').last,
    };
    expect(realtime, isNotEmpty);
    expect(
      realtime,
      everyElement(anyOf('realtime_client.dart', 'realtime_frames.dart')),
    );
  });

  test('reads no account permission or role except the create gate', () {
    // In-community actions follow the server's `me`. The one institution-level
    // action — creating a community, which has no `me` yet — is gated on the
    // identity permission `communities.create`, exactly as messaging gates its
    // start-a-conversation permissions; the server still re-authorises. That
    // single read is the only account-permission read allowed here.
    final allowed = RegExp(r"\.can\('communities\.create'\)");
    final forbidden = RegExp(r'\.permissions\b|\.roles\b|\.can\(');
    final offenders = [
      for (final path in community)
        for (final line in sources[path]!.split('\n'))
          if (forbidden.hasMatch(line) && !allowed.hasMatch(line))
            '$path: ${line.trim()}',
    ];
    expect(offenders, isEmpty);
  });

  test('lets only the provider wiring choose an implementation', () {
    final constructing = [
      for (final MapEntry(key: path, value: text) in sources.entries)
        if (RegExp(r'\b(Http|Mock)CommunityRepository\(').hasMatch(text) &&
            !path.endsWith('_community_repository.dart'))
          path,
    ];
    expect(constructing, ['lib/providers/app_providers.dart']);
  });

  test('keeps the community wire models plain Dart', () {
    // Only the provenance enum beside them, which imports nothing itself.
    expect(imports['lib/data/models/communities.dart'], ['data_origin.dart']);
    expect(imports['lib/data/models/data_origin.dart'], isEmpty);
  });

  test('never lets the real repository read the demo’s invented data', () {
    expect(
      imports['lib/data/repositories/http/http_community_repository.dart']!
          .where((uri) => uri.contains('mock')),
      isEmpty,
    );
  });

  group('the real repository', () {
    final http =
        sources['lib/data/repositories/http/http_community_repository.dart']!;
    // Each call as written: its method, and its path up to the first comma
    // or closing parenthesis outside a string.
    final calls = [
      for (final m in RegExp(
        r"""_api\.(\w+)\(\s*('[^'\n]*'|[\w.]+\([\w., ]*\)|[\w.]+)""",
      ).allMatches(http))
        '${m.group(1)} ${m.group(2)}',
    ];

    test('makes exactly these calls — a new one is a change to this list', () {
      expect(calls, unorderedEquals(_allowedCalls));
      // Nothing reaches the API client past the pattern above, apart from
      // `_api.resolve` — a URL helper, not an HTTP call, used to turn the
      // server's relative avatar link into an absolute one (ADR 0038). Every
      // actual HTTP call still carries a verb and must be in the list below.
      final resolveCalls = RegExp(r'\b_api\.resolve\(').allMatches(http).length;
      expect(
        RegExp(r'\b_api\.').allMatches(http),
        hasLength(calls.length + resolveCalls),
      );
      expect(
        RegExp(r'\b\w+\.(get|post|put|patch|delete)\(').allMatches(http),
        hasLength(calls.length),
      );
    });

    test('adds members by id through one server-gated route (Owner A1/A4/A2)', () {
      // The direct add — deferred until a people-lookup policy existed
      // (Q6/Q22/Q31/Q50) — is now approved: a holder of
      // `community.members.invite` adds (or re-adds) people found through the
      // people search. It is exactly one POST to /members, carrying ONLY
      // account ids — never a role, a standing or any other claim the client
      // could assert; the server re-authorises every add. Joining on one's own
      // request stays by link (the `join` call remains).
      expect(
        calls.where((c) => c.startsWith('post ') && c.contains('/members')),
        hasLength(1),
      );
      // The add carries only account ids — no role, standing or other claim.
      expect(http, contains("body: {'userIds': userIds}"));
      expect(calls.where((c) => c.contains('/join')), isNotEmpty);
    });
  });

  test('keeps web-only code in lib/app, out of the features', () {
    final offenders = [
      for (final MapEntry(key: path, value: uris) in imports.entries)
        if (path.startsWith('lib/features/'))
          for (final uri in uris)
            if (uri.startsWith('package:flutter_web_plugins') ||
                uri.startsWith('package:web/') ||
                uri == 'dart:js_interop' ||
                uri == 'dart:ui_web' ||
                // A feature writes a link through inviteLinkBuilderProvider.
                uri.contains('invite_link'))
              '$path → $uri',
    ];
    expect(offenders, isEmpty);
    // The browser is reached in one file, swapped in on the web alone.
    expect(imports['lib/app/invite_link_web.dart'], [
      'package:flutter_web_plugins/url_strategy.dart',
      'invite_link_parts.dart',
    ]);
    expect(imports['lib/app/invite_link_stub.dart'], isEmpty);
    expect(imports['lib/app/invite_link_parts.dart'], isEmpty);
    expect(
      RegExp(
        r'''export\s+'invite_link_stub\.dart'\s+if\s+\(dart\.library\.js_interop\)\s+'invite_link_web\.dart';''',
      ).hasMatch(sources['lib/app/invite_link.dart']!),
      isTrue,
    );
  });

  test('never logs where an invitation token passes', () {
    final watched = [
      for (final path in sources.keys)
        if (path.startsWith('lib/features/communities/') ||
            path.startsWith('lib/app/invite_link') ||
            path == 'lib/main.dart' ||
            path == 'lib/data/models/communities.dart' ||
            path.endsWith('_community_repository.dart'))
          path,
    ];
    expect(watched.length, greaterThanOrEqualTo(15));
    final logging = RegExp(r'\b(print|debugPrint\w*|log)\(');
    final offenders = [
      for (final path in watched)
        if (logging.hasMatch(sources[path]!) ||
            imports[path]!.contains('dart:developer'))
          path,
    ];
    expect(offenders, isEmpty);
  });

  test('never prints an invitation token', () {
    const token = 'TokenThatMustNeverBePrinted_0000000000000000';
    final created = CreatedInvitation(
      invitation: CommunityInvitation(
        id: 'invitation-1',
        createdAt: DateTime.utc(2026, 9, 20),
        expiresAt: DateTime.utc(2026, 9, 27),
        uses: 0,
        state: InvitationState.active,
      ),
      token: token,
    );
    expect('$created', isNot(contains(token)));
    expect('$created', contains('invitation-1'));

    const pending = PendingInvitation(serial: 7, token: token);
    expect('$pending', isNot(contains(token)));

    final container = ProviderContainer();
    addTearDown(container.dispose);
    container.read(pendingInvitationProvider.notifier).offer(token);
    final held = container.read(pendingInvitationProvider);
    expect(held?.token, token);
    expect('$held', isNot(contains(token)));
  });

  test('lays out right to left: nothing pinned to a physical side', () {
    final physical = RegExp(
      r'EdgeInsets\.(only|fromLTRB)\([^)]*\b(left|right)\b|'
      r'EdgeInsets\.fromLTRB|'
      r'Alignment\.(centerLeft|centerRight|topLeft|topRight|bottomLeft|bottomRight)|'
      r'TextAlign\.(left|right)|'
      r'Positioned\([^)]*\b(left|right):',
    );
    final offenders = [
      for (final path in community)
        if (physical.hasMatch(sources[path]!)) path,
    ];
    expect(offenders, isEmpty);
  });

  test('says things in one place: no Arabic outside CommunityCopy', () {
    final arabicLiteral = RegExp(r'''(['"])[^'"\n]*[؀-ۿ][^'"\n]*\1''');
    final plain = [
      'lib/data/models/communities.dart',
      'lib/data/repositories/http/http_community_repository.dart',
      for (final path in community)
        if (!path.endsWith('/community_copy.dart')) path,
    ];
    for (final path in plain) {
      expect(
        arabicLiteral.allMatches(sources[path]!).map((m) => m.group(0)),
        isEmpty,
        reason: '$path should take its words from CommunityCopy',
      );
    }
    expect(
      arabicLiteral.hasMatch(
        sources['lib/features/communities/community_copy.dart']!,
      ),
      isTrue,
    );
  });
}

/// Every call the real repository makes: the three reads of P5, and what
/// P5.1 builds on — links, joining, removing and leaving, the lifecycle,
/// grants and ownership. Never `POST …/members`: no one is added by id.
const _allowedCalls = [
  "get '/communities'",
  "post '/communities'",
  'get _community(communityId)',
  r"get '${_community(communityId)}/members'",
  r"get '${_community(communityId)}/member-candidates'",
  r"post '${_community(communityId)}/members'",
  r"post '${_community(communityId)}/invitations'",
  r"get '${_community(communityId)}/invitations'",
  r"post '${_community(communityId)}/invitations/${_segment(invitationId)}/revoke'",
  "post '/communities/join'",
  r"delete '${_community(communityId)}/members/${_segment(userId)}'",
  r"post '${_community(communityId)}/leave'",
  r"post '${_community(communityId)}/lock'",
  r"post '${_community(communityId)}/unlock'",
  r"get '${_community(communityId)}/grants'",
  r"post '${_community(communityId)}/grants'",
  r"delete '${_community(communityId)}/grants/${_segment(grantId)}'",
  r"put '${_community(communityId)}/owner'",
  r"post '${_community(communityId)}/halaqat'",
  r"delete '${_community(communityId)}/halaqat/${_segment(halaqaId)}'",
  r"put '${_community(communityId)}/profile'",
  r"get '${_community(communityId)}/avatar'",
  r"put '${_community(communityId)}/chat-mode'",
];
