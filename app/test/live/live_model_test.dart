import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';

/// The live wire models, parsed defensively like communities: a state or role
/// this version does not know is `unknown`, a field it cannot read is not read,
/// and what the viewer may do is the server's `me` — never worked out here.
void main() {
  Map<String, Object?> sessionJson({
    Object? id = 's-1',
    Object? state = 'live',
    Object? me = const {
      'role': 'listener',
      'isHost': false,
      'canModerate': false,
    },
  }) => {
    'id': id,
    'communityId': 'c-1',
    'state': state,
    'hostUserId': 'u-host',
    'startedAt': '2026-01-01T00:00:00.000Z',
    'speakerCount': 2,
    'me': me,
  };

  group('LiveSession.fromJson', () {
    test('reads a running session and its me block', () {
      final session = LiveSession.fromJson(
        sessionJson(
          me: const {'role': 'moderator', 'isHost': true, 'canModerate': true},
        ),
      );
      expect(session.id, 's-1');
      expect(session.communityId, 'c-1');
      expect(session.state, LiveSessionState.live);
      expect(session.isLive, isTrue);
      expect(session.hostUserId, 'u-host');
      expect(session.speakerCount, 2);
      expect(session.me.role, LiveParticipantRole.moderator);
      expect(session.me.isHost, isTrue);
      expect(session.me.canModerate, isTrue);
      expect(session.origin, DataOrigin.records); // the default
    });

    test('maps an unknown state to unknown (and isLive is false)', () {
      final session = LiveSession.fromJson(sessionJson(state: 'paused'));
      expect(session.state, LiveSessionState.unknown);
      expect(session.isLive, isFalse);
    });

    test('maps an unknown role to unknown', () {
      final session = LiveSession.fromJson(
        sessionJson(me: const {'role': 'producer'}),
      );
      expect(session.me.role, LiveParticipantRole.unknown);
      expect(session.me.isHost, isFalse);
      expect(session.me.canModerate, isFalse);
    });

    test('defaults the me block when the server sends none', () {
      final json = sessionJson()..remove('me');
      final session = LiveSession.fromJson(json);
      expect(session.me.role, LiveParticipantRole.unknown);
      expect(session.me.isHost, isFalse);
      expect(session.me.canModerate, isFalse);
    });

    test('throws FormatException when it cannot be identified or dated', () {
      expect(
        () => LiveSession.fromJson(sessionJson(id: 123)),
        throwsFormatException,
      );
      final undated = sessionJson()..remove('startedAt');
      expect(() => LiveSession.fromJson(undated), throwsFormatException);
    });

    test('carries the origin it is given (mock in the demo)', () {
      final session = LiveSession.fromJson(
        sessionJson(),
        origin: DataOrigin.mock,
      );
      expect(session.origin, DataOrigin.mock);
      expect(session.origin.isMock, isTrue);
    });
  });

  group('LiveException', () {
    test('classifies refusals by code, not by reason', () {
      expect(const LiveException('live.session_not_found', '').isGone, isTrue);
      expect(
        const LiveException('live.community_not_found', '').isGone,
        isTrue,
      );
      expect(
        const LiveException('live.not_a_moderator', '').isForbidden,
        isTrue,
      );
      expect(
        const LiveException('identity.permission_denied', '').isForbidden,
        isTrue,
      );
      expect(const LiveException('network.unreachable', '').isNetwork, isTrue);
      expect(
        const LiveException('identity.authentication_required', '').needsSignIn,
        isTrue,
      );
      expect(const LiveException('unavailable', '').isUnavailable, isTrue);
      // The code and message are what it carries; the id is never in toString.
      expect(
        const LiveException('live.unreadable', 'bad').toString(),
        contains('live.unreadable'),
      );
    });
  });
}
