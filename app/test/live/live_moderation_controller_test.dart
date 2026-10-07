import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/live/state/live_moderation_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// A repository that records exactly which command it was asked to run, with
/// what arguments, and answers a fixed result (or throws a set error). The
/// read methods throw: the moderation controller must never call them.
class _RecordingLive implements LiveRepository {
  final List<String> calls = [];
  Object? error;

  LiveSession _session({
    String id = 's-1',
    LiveSessionState state = LiveSessionState.live,
    List<String> presenters = const [],
  }) => LiveSession(
    id: id,
    communityId: 'c-1',
    state: state,
    hostUserId: 'u-host',
    startedAt: DateTime.utc(2026),
    speakerCount: 1,
    presenterUserIds: presenters,
    me: const LiveMe(role: LiveParticipantRole.moderator, canModerate: true),
    origin: DataOrigin.records,
  );

  Never _maybeThrow() => throw error!;

  @override
  Future<LiveSession> endSession(String sessionId) async {
    calls.add('endSession:$sessionId');
    if (error != null) _maybeThrow();
    return _session(state: LiveSessionState.ended);
  }

  @override
  Future<bool> removeParticipant(
    String sessionId,
    String userId, {
    String? reason,
  }) async {
    calls.add('removeParticipant:$sessionId:$userId:reason=$reason');
    if (error != null) _maybeThrow();
    return true;
  }

  @override
  Future<bool> resetRoom(String sessionId) async {
    calls.add('resetRoom:$sessionId');
    if (error != null) _maybeThrow();
    return true;
  }

  @override
  Future<LiveSession> claimPresenter(String sessionId) async {
    calls.add('claimPresenter:$sessionId');
    if (error != null) _maybeThrow();
    return _session(presenters: const ['u-host']);
  }

  @override
  Future<LiveSession> stopPresenter(String sessionId) async {
    calls.add('stopPresenter:$sessionId');
    if (error != null) _maybeThrow();
    return _session();
  }

  @override
  Future<LiveSession> grantPresenter(String sessionId, String userId) async {
    calls.add('grantPresenter:$sessionId:$userId');
    if (error != null) _maybeThrow();
    return _session(presenters: [userId]);
  }

  @override
  Future<LiveSession> revokePresenter(String sessionId, String userId) async {
    calls.add('revokePresenter:$sessionId:$userId');
    if (error != null) _maybeThrow();
    return _session();
  }

  // Reads are the state layer's business, never the command layer's.
  @override
  Future<LiveSession?> currentSession(String communityId) =>
      throw UnimplementedError();
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

void main() {
  late _RecordingLive repo;
  late ProviderContainer container;

  setUp(() {
    repo = _RecordingLive();
    container = ProviderContainer(
      overrides: [liveRepositoryProvider.overrideWithValue(repo)],
    );
    addTearDown(container.dispose);
  });

  LiveModerationController controller() =>
      container.read(liveModerationProvider);

  group('forwards each command to the repository and returns its answer', () {
    test('endSession', () async {
      final session = await controller().endSession('s-1');
      expect(repo.calls, ['endSession:s-1']);
      expect(session.state, LiveSessionState.ended);
    });

    test('removeParticipant forwards the reason', () async {
      final removed = await controller().removeParticipant(
        's-1',
        'u-2',
        reason: 'disruptive',
      );
      expect(removed, isTrue);
      expect(repo.calls, ['removeParticipant:s-1:u-2:reason=disruptive']);
    });

    test('removeParticipant without a reason forwards null', () async {
      await controller().removeParticipant('s-1', 'u-2');
      expect(repo.calls, ['removeParticipant:s-1:u-2:reason=null']);
    });

    test('resetRoom', () async {
      expect(await controller().resetRoom('s-1'), isTrue);
      expect(repo.calls, ['resetRoom:s-1']);
    });

    test('claimPresenter / stopPresenter', () async {
      final claimed = await controller().claimPresenter('s-1');
      expect(claimed.presenterUserIds, ['u-host']);
      final stopped = await controller().stopPresenter('s-1');
      expect(stopped.presenterUserIds, isEmpty);
      expect(repo.calls, ['claimPresenter:s-1', 'stopPresenter:s-1']);
    });

    test('grantPresenter / revokePresenter forward the target id', () async {
      final granted = await controller().grantPresenter('s-1', 'u-2');
      expect(granted.presenterUserIds, ['u-2']);
      await controller().revokePresenter('s-1', 'u-2');
      expect(repo.calls, ['grantPresenter:s-1:u-2', 'revokePresenter:s-1:u-2']);
    });
  });

  group('propagates repository refusals unchanged', () {
    test('a LiveException from a command is not swallowed', () async {
      repo.error = const LiveException('live.not_a_moderator', 'no');
      await expectLater(
        controller().endSession('s-1'),
        throwsA(
          isA<LiveException>()
              .having((e) => e.code, 'code', 'live.not_a_moderator')
              .having((e) => e.isForbidden, 'isForbidden', isTrue),
        ),
      );
    });

    test('a 409 presenter-slots-full surfaces as LiveException', () async {
      repo.error = const LiveException('live.presenter_slots_full', 'full');
      await expectLater(
        controller().claimPresenter('s-1'),
        throwsA(
          isA<LiveException>().having(
            (e) => e.code,
            'code',
            'live.presenter_slots_full',
          ),
        ),
      );
    });
  });

  test('a command sends to the server with no local gate, no read, no state', () async {
    // Even though the controller has a LiveException set as if the server will
    // refuse, the command is still SENT — the app never pre-decides
    // authorization. And only the command method is called: no currentSession/
    // getSession read, so nothing reconciles or mutates session state here.
    repo.error = const LiveException('live.not_a_moderator', 'no');
    await controller().endSession('s-1').then((_) {}, onError: (_) {});
    expect(repo.calls, ['endSession:s-1']);
    expect(
      repo.calls.where(
        (c) =>
            c.startsWith('currentSession') ||
            c.startsWith('getSession') ||
            c.startsWith('hands'),
      ),
      isEmpty,
    );
  });
}
