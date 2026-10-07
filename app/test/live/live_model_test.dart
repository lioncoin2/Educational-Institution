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

    // Regression: the minimal shape the earlier foundation read still parses,
    // with the new fields taking their benign defaults.
    test('reads the minimal shape, defaulting the fields added in Slice 2', () {
      final session = LiveSession.fromJson(sessionJson());
      expect(session.stateVersion, 0);
      expect(session.endedAt, isNull);
      expect(session.endReason, isNull);
      expect(session.participantCap, 0);
      expect(session.presenterUserIds, isEmpty);
      expect(session.moderation, isNull);
      expect(session.me.canJoin, isFalse);
      expect(session.me.canEnd, isFalse);
      expect(session.me.canPresent, isFalse);
      expect(session.me.presenting, isFalse);
      expect(session.me.hand, isNull);
    });
  });

  group('LiveSession.fromJson — full view (Slice 2)', () {
    // The whole LiveSessionView as the backend builds it (responses.ts).
    Map<String, Object?> fullJson({
      Object? stateVersion = 7,
      Object? endedAt,
      Object? endReason,
      Object? participantCap = 300,
      Object? presenterUserIds = const ['teacher-1', 'teacher-2'],
      Object? moderation = const {
        'pendingHands': 3,
        'violations': 1,
        'lastViolationAt': '2026-01-01T00:05:00.000Z',
      },
      Object? me = const {
        'role': 'moderator',
        'isHost': true,
        'canJoin': true,
        'canRaiseHand': false,
        'canModerate': true,
        'canEnd': true,
        'canPresent': true,
        'presenting': false,
        'hand': {'requestId': 'r-1', 'state': 'pending'},
      },
    }) => {
      'id': 's-1',
      'communityId': 'c-1',
      'state': 'live',
      'stateVersion': stateVersion,
      'hostUserId': 'u-host',
      'startedAt': '2026-01-01T00:00:00.000Z',
      'endedAt': endedAt,
      'endReason': endReason,
      'participantCap': participantCap,
      'speakerCount': 2,
      'presenterUserIds': presenterUserIds,
      'me': me,
      'moderation': moderation,
    };

    test('reads every field of a full running session', () {
      final s = LiveSession.fromJson(fullJson());
      expect(s.id, 's-1');
      expect(s.communityId, 'c-1');
      expect(s.state, LiveSessionState.live);
      expect(s.stateVersion, 7);
      expect(s.hostUserId, 'u-host');
      expect(s.startedAt, DateTime.parse('2026-01-01T00:00:00.000Z'));
      expect(s.endedAt, isNull);
      expect(s.endReason, isNull);
      expect(s.participantCap, 300);
      expect(s.speakerCount, 2);
      expect(s.presenterUserIds, ['teacher-1', 'teacher-2']);
    });

    test('reads the full me block — every flag the server computed', () {
      final me = LiveSession.fromJson(fullJson()).me;
      expect(me.role, LiveParticipantRole.moderator);
      expect(me.isHost, isTrue);
      expect(me.canJoin, isTrue);
      expect(me.canRaiseHand, isFalse);
      expect(me.canModerate, isTrue);
      expect(me.canEnd, isTrue);
      expect(me.canPresent, isTrue);
      expect(me.presenting, isFalse);
      expect(me.hand, isNotNull);
      expect(me.hand!.requestId, 'r-1');
      expect(me.hand!.state, SpeakerRequestState.pending);
    });

    test('reads an ended session with its reason', () {
      final s = LiveSession.fromJson(
        fullJson(
          stateVersion: 9,
          endedAt: '2026-01-01T01:00:00.000Z',
          endReason: 'moderator',
        )..['state'] = 'ended',
      );
      expect(s.state, LiveSessionState.ended);
      expect(s.isLive, isFalse);
      expect(s.endedAt, DateTime.parse('2026-01-01T01:00:00.000Z'));
      expect(s.endReason, LiveSessionEndReason.moderator);
    });

    test('maps each end reason, and an unknown value to unknown', () {
      LiveSessionEndReason? reasonOf(Object? wire) =>
          LiveSession.fromJson(fullJson(endReason: wire)).endReason;
      expect(reasonOf('moderator'), LiveSessionEndReason.moderator);
      expect(reasonOf('idle'), LiveSessionEndReason.idle);
      expect(
        reasonOf('community_closed'),
        LiveSessionEndReason.communityClosed,
      );
      expect(reasonOf('force_majeure'), LiveSessionEndReason.unknown);
      expect(reasonOf(null), isNull); // absent stays null, never "unknown"
    });

    test('maps an unknown hand state to unknown, and no hand to null', () {
      final unknownHand = LiveSession.fromJson(
        fullJson(
          me: const {
            'role': 'listener',
            'hand': {'requestId': 'r-9', 'state': 'escalated'},
          },
        ),
      ).me;
      expect(unknownHand.hand!.state, SpeakerRequestState.unknown);
      final noHand = LiveSession.fromJson(
        fullJson(me: const {'role': 'listener'}),
      ).me;
      expect(noHand.hand, isNull);
    });

    test('reads the moderation block, and null when the server omits it', () {
      final mod = LiveSession.fromJson(fullJson()).moderation;
      expect(mod, isNotNull);
      expect(mod!.pendingHands, 3);
      expect(mod.violations, 1);
      expect(mod.lastViolationAt, DateTime.parse('2026-01-01T00:05:00.000Z'));
      // A listener's view carries no moderation block.
      expect(
        LiveSession.fromJson(fullJson()..remove('moderation')).moderation,
        isNull,
      );
      // lastViolationAt is nullable: no violation yet.
      final noViolation = LiveSession.fromJson(
        fullJson(moderation: const {'pendingHands': 0, 'violations': 0}),
      ).moderation;
      expect(noViolation!.lastViolationAt, isNull);
    });

    test('reads presenterUserIds as a plural list — empty, one, or two', () {
      List<String> presentersOf(Object? value) =>
          LiveSession.fromJson(fullJson(presenterUserIds: value))
              .presenterUserIds;
      expect(presentersOf(const <String>[]), isEmpty);
      expect(presentersOf(const ['teacher-1']), ['teacher-1']);
      expect(presentersOf(const ['teacher-1', 'student-9']), [
        'teacher-1',
        'student-9',
      ]);
    });

    test('parses stateVersion exactly and never compares it', () {
      // The model carries the version as the server sends it; it does not
      // judge newer/older — that is a later slice's job.
      expect(LiveSession.fromJson(fullJson(stateVersion: 1)).stateVersion, 1);
      expect(LiveSession.fromJson(fullJson(stateVersion: 42)).stateVersion, 42);
    });

    test('reads optional and malformed fields defensively, never crashing', () {
      // Missing counts default; a non-list / non-num / bad instant is tolerated.
      final s = LiveSession.fromJson(
        fullJson(presenterUserIds: 'not-a-list', endedAt: 'not-a-date')
          ..remove('stateVersion')
          ..remove('participantCap'),
      );
      expect(s.stateVersion, 0);
      expect(s.participantCap, 0);
      expect(s.presenterUserIds, isEmpty);
      expect(s.endedAt, isNull);
      // A non-string element in the list is skipped, not fatal.
      expect(
        LiveSession.fromJson(
          fullJson(presenterUserIds: const ['teacher-1', 42, 'student-9']),
        ).presenterUserIds,
        ['teacher-1', 'student-9'],
      );
      // A hand that is not an object is simply no hand.
      expect(
        LiveSession.fromJson(
          fullJson(me: const {'role': 'listener', 'hand': 'nope'}),
        ).me.hand,
        isNull,
      );
    });

    test('still throws only for an unidentifiable or undatable session', () {
      expect(
        () => LiveSession.fromJson(fullJson()..['id'] = 123),
        throwsFormatException,
      );
      expect(
        () => LiveSession.fromJson(fullJson()..remove('startedAt')),
        throwsFormatException,
      );
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
