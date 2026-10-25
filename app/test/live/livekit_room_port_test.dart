import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/livekit/livekit_room_port.dart';
import 'package:quran_institution_app/data/models/live_media.dart';

/// A [LiveKitLiveRoom] the test drives in place of a real LiveKit room: it
/// records each teardown call and its order, and can be told to throw on any
/// one of the three cleanup steps. No SDK, no network — so the port's teardown
/// orchestration is exercised deterministically.
class _FakeLiveRoom implements LiveKitLiveRoom {
  _FakeLiveRoom({this.id = 'room'});

  final String id;
  final List<String> order = [];
  int disposeListenerCalls = 0;
  int disconnectCalls = 0;
  int disposeCalls = 0;
  Object? failDisposeListener;
  Object? failDisconnect;
  Object? failDispose;
  final List<bool> micCommands = [];
  final List<(bool enabled, bool captureScreenAudio)> screenCommands = [];

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async {
    micCommands.add(enabled);
  }

  @override
  Future<void> setScreenShareEnabled(
    bool enabled, {
    bool captureScreenAudio = false,
  }) async {
    screenCommands.add((enabled, captureScreenAudio));
  }

  @override
  Future<void> disposeListener() async {
    disposeListenerCalls += 1;
    order.add('disposeListener');
    if (failDisposeListener != null) throw failDisposeListener!;
  }

  @override
  Future<void> disconnect() async {
    disconnectCalls += 1;
    order.add('disconnect');
    if (failDisconnect != null) throw failDisconnect!;
  }

  @override
  Future<void> dispose() async {
    disposeCalls += 1;
    order.add('dispose');
    if (failDispose != null) throw failDispose!;
  }
}

/// An opener that hands out the given rooms in order, one per [connect]. Fails
/// the test if asked for more rooms than provided.
LiveKitRoomOpener _openerFor(List<_FakeLiveRoom> rooms) {
  final queue = List<_FakeLiveRoom>.from(rooms);
  return (url, token, emit) async {
    expect(
      queue,
      isNotEmpty,
      reason: 'the opener was called more times than rooms were provided',
    );
    return queue.removeAt(0);
  };
}

void main() {
  group('SdkLiveKitRoomPort teardown', () {
    test('a clean teardown disposes the listener, disconnects, then disposes '
        'the room — in that order', () async {
      final room = _FakeLiveRoom();
      final port = SdkLiveKitRoomPort(openRoom: _openerFor([room]));
      await port.connect('wss://x', 'tok');

      await port.disconnect();

      expect(room.order, ['disposeListener', 'disconnect', 'dispose']);
      await port.dispose();
    });

    test('a throwing listener disposal does NOT prevent room disconnect and '
        'room disposal', () async {
      final room = _FakeLiveRoom()
        ..failDisposeListener = Exception('listener boom');
      final port = SdkLiveKitRoomPort(openRoom: _openerFor([room]));
      await port.connect('wss://x', 'tok');

      // The first failure is rethrown (callers' contracts are unchanged), but
      // every owned resource is still released first.
      await expectLater(port.disconnect(), throwsA(isA<Exception>()));

      expect(room.disposeListenerCalls, 1);
      expect(
        room.disconnectCalls,
        1,
        reason: 'room disconnect must still be attempted',
      );
      expect(
        room.disposeCalls,
        1,
        reason: 'room dispose must still be attempted',
      );
      expect(room.order, ['disposeListener', 'disconnect', 'dispose']);
      await port.dispose();
    });

    test('a throwing room disconnect does NOT prevent room disposal', () async {
      final room = _FakeLiveRoom()
        ..failDisconnect = Exception('disconnect boom');
      final port = SdkLiveKitRoomPort(openRoom: _openerFor([room]));
      await port.connect('wss://x', 'tok');

      await expectLater(port.disconnect(), throwsA(isA<Exception>()));

      expect(room.disconnectCalls, 1);
      expect(
        room.disposeCalls,
        1,
        reason: 'room dispose must still be attempted after disconnect fails',
      );
      await port.dispose();
    });

    test(
      'dispose() closes the signal controller even when teardown throws',
      () async {
        final room = _FakeLiveRoom()..failDispose = Exception('dispose boom');
        final port = SdkLiveKitRoomPort(openRoom: _openerFor([room]));
        await port.connect('wss://x', 'tok');

        var closed = false;
        port.signals.listen((_) {}, onDone: () => closed = true);

        // dispose() rethrows the teardown failure, but only AFTER closing.
        await expectLater(port.dispose(), throwsA(isA<Exception>()));
        await pumpEventQueue();

        expect(
          closed,
          isTrue,
          reason: 'the broadcast controller must be closed despite the failure',
        );
      },
    );

    test(
      'reconnecting after a failed cleanup never reuses the orphaned room',
      () async {
        final first = _FakeLiveRoom(id: 'first')
          ..failDisposeListener = Exception('boom');
        final second = _FakeLiveRoom(id: 'second');
        final port = SdkLiveKitRoomPort(openRoom: _openerFor([first, second]));

        await port.connect('wss://x', 'tok'); // opens `first`
        await expectLater(port.disconnect(), throwsA(isA<Exception>()));
        expect(first.disposeListenerCalls, 1);
        expect(first.disconnectCalls, 1);
        expect(first.disposeCalls, 1);

        // A fresh connect opens `second`; because `_room` was cleared FIRST during
        // the failed teardown, the orphaned `first` is never touched again.
        await port.connect('wss://x', 'tok'); // opens `second`
        expect(
          first.disposeListenerCalls,
          1,
          reason: 'the orphaned room must never be torn down a second time',
        );
        expect(first.disconnectCalls, 1);
        expect(first.disposeCalls, 1);

        await port.disconnect(); // tears down `second`
        expect(second.order, ['disposeListener', 'disconnect', 'dispose']);
        await port.dispose();
      },
    );

    test(
      'connect tears down a still-open previous room best-effort — a stale '
      'teardown failure must not block the new join (reconnect path)',
      () async {
        final first = _FakeLiveRoom(id: 'first')
          ..failDisconnect = Exception('stale room boom');
        final second = _FakeLiveRoom(id: 'second');
        final port = SdkLiveKitRoomPort(openRoom: _openerFor([first, second]));

        await port.connect('wss://x', 'tok'); // opens `first`, still open
        // Reconnect WITHOUT an explicit disconnect (as roomDeleted auto-rejoin
        // does): `first` is torn down and its disconnect throws, but that stale
        // failure must not surface as a join failure — the new join succeeds.
        await expectLater(port.connect('wss://y', 'tok2'), completes);

        // `first` still received every teardown attempt...
        expect(first.order, ['disposeListener', 'disconnect', 'dispose']);
        // ...and `second` is now the live room, untouched until we leave.
        expect(second.disconnectCalls, 0);

        await port.disconnect(); // tears down `second`
        expect(second.order, ['disposeListener', 'disconnect', 'dispose']);
        await port.dispose();
      },
    );

    test(
      'signals emitted by the opened room surface on the port stream',
      () async {
        late void Function(LiveKitRoomSignal) emit;
        final port = SdkLiveKitRoomPort(
          openRoom: (url, token, e) async {
            emit = e;
            return _FakeLiveRoom();
          },
        );
        final events = <LiveKitRoomSignal>[];
        port.signals.listen(events.add);

        await port.connect('wss://x', 'tok');
        emit(const LiveKitConnected());
        await pumpEventQueue();

        expect(events, [isA<LiveKitConnected>()]);
        await port.dispose();
      },
    );
  });

  group('SdkLiveKitRoomPort publish forwarding', () {
    test('mic and screen commands reach the open room; screenAudio stays off', () async {
      final room = _FakeLiveRoom();
      final port = SdkLiveKitRoomPort(openRoom: _openerFor([room]));
      await port.connect('wss://x', 'tok');

      await port.setMicrophoneEnabled(true);
      await port.setMicrophoneEnabled(false);
      await port.setScreenShareEnabled(true);

      expect(room.micCommands, [true, false]);
      // Q56: screen audio is never forced on by the port.
      expect(room.screenCommands, [(true, false)]);
      await port.dispose();
    });

    test('publish commands are safe no-ops with no open room', () async {
      final room = _FakeLiveRoom();
      final port = SdkLiveKitRoomPort(openRoom: _openerFor([room]));

      // Before any connect: no room, no throw, nothing forwarded.
      await port.setMicrophoneEnabled(true);
      await port.setScreenShareEnabled(true);
      expect(room.micCommands, isEmpty);
      expect(room.screenCommands, isEmpty);

      // And again after a teardown: the room was cleared, so it is a no-op.
      await port.connect('wss://x', 'tok');
      await port.disconnect();
      await port.setMicrophoneEnabled(true);
      expect(room.micCommands, isEmpty);
      await port.dispose();
    });
  });

  group('SdkLiveKitRoomPort connect failure', () {
    test(
      'an opener failure propagates and leaves the port with no room',
      () async {
        var calls = 0;
        final second = _FakeLiveRoom(id: 'second');
        final port = SdkLiveKitRoomPort(
          openRoom: (url, token, emit) async {
            calls += 1;
            if (calls == 1) throw Exception('join boom');
            return second;
          },
        );

        // The join failure surfaces (the adapter maps it to a media failure)...
        await expectLater(
          port.connect('wss://x', 'tok'),
          throwsA(isA<Exception>()),
        );
        // ...and nothing is retained: a publish is a safe no-op and a later
        // disconnect tears down no orphaned transport from the failed join.
        await port.setMicrophoneEnabled(true);
        expect(second.micCommands, isEmpty);
        await port.disconnect(); // no room → no-op, no throw

        // A fresh connect then yields a live room that receives commands.
        await port.connect('wss://y', 'tok2');
        await port.setMicrophoneEnabled(true);
        expect(second.micCommands, [true]);
        await port.dispose();
      },
    );
  });

  group('screenPublishAllowed (mirrors the backend rule)', () {
    // Proto TrackSource wire values: microphone = 2, screen_share = 3.
    test('can-publish AND (no explicit sources ⇒ all, or screen is listed)', () {
      expect(
        screenPublishAllowed(canPublish: false, sourceValues: const []),
        isFalse,
        reason: 'cannot publish anything',
      );
      expect(
        screenPublishAllowed(canPublish: false, sourceValues: const [3]),
        isFalse,
        reason: 'canPublish=false overrides a listed source',
      );
      expect(
        screenPublishAllowed(canPublish: true, sourceValues: const []),
        isTrue,
        reason: 'empty explicit sources means every source is allowed',
      );
      expect(
        screenPublishAllowed(canPublish: true, sourceValues: const [2]),
        isFalse,
        reason: 'microphone-only grant does not allow screen',
      );
      expect(
        screenPublishAllowed(canPublish: true, sourceValues: const [2, 3]),
        isTrue,
      );
      expect(
        screenPublishAllowed(canPublish: true, sourceValues: const [3]),
        isTrue,
      );
    });
  });

  group('micPublishAllowed (the "may speak" capability rule)', () {
    // Proto TrackSource wire values: microphone = 2, screen_share = 3. The same
    // shape as screenPublishAllowed, read for the microphone source.
    test('can-publish AND (no explicit sources ⇒ all, or microphone is listed)', () {
      expect(
        micPublishAllowed(canPublish: false, sourceValues: const []),
        isFalse,
        reason: 'cannot publish anything',
      );
      expect(
        micPublishAllowed(canPublish: false, sourceValues: const [2]),
        isFalse,
        reason: 'canPublish=false overrides a listed microphone source',
      );
      expect(
        micPublishAllowed(canPublish: true, sourceValues: const []),
        isTrue,
        reason: 'empty explicit sources means every source is allowed',
      );
      expect(
        micPublishAllowed(canPublish: true, sourceValues: const [3]),
        isFalse,
        reason: 'a screen-only grant does not allow the microphone',
      );
      expect(
        micPublishAllowed(canPublish: true, sourceValues: const [2]),
        isTrue,
      );
      expect(
        micPublishAllowed(canPublish: true, sourceValues: const [2, 3]),
        isTrue,
      );
    });
  });

  group('SdkLiveKitRoomPort capability signal', () {
    test('a capability signal from the room surfaces on the port stream', () async {
      late void Function(LiveKitRoomSignal) emit;
      final port = SdkLiveKitRoomPort(
        openRoom: (url, token, e) async {
          emit = e;
          return _FakeLiveRoom();
        },
      );
      final events = <LiveKitRoomSignal>[];
      port.signals.listen(events.add);

      await port.connect('wss://x', 'tok');
      emit(const LiveKitCapabilities(canPublishScreen: true));
      await pumpEventQueue();

      expect(events.single, isA<LiveKitCapabilities>());
      expect((events.single as LiveKitCapabilities).canPublishScreen, isTrue);
      await port.dispose();
    });

    test('a local-tracks signal from the room surfaces on the port stream', () async {
      late void Function(LiveKitRoomSignal) emit;
      final port = SdkLiveKitRoomPort(
        openRoom: (url, token, e) async {
          emit = e;
          return _FakeLiveRoom();
        },
      );
      final events = <LiveKitRoomSignal>[];
      port.signals.listen(events.add);

      await port.connect('wss://x', 'tok');
      emit(const LiveKitLocalTracks(microphoneOn: true, screenShareOn: false));
      await pumpEventQueue();

      expect(events.single, isA<LiveKitLocalTracks>());
      final tracks = events.single as LiveKitLocalTracks;
      expect(tracks.microphoneOn, isTrue);
      expect(tracks.screenShareOn, isFalse);
      await port.dispose();
    });

    test('a remote-participants signal surfaces on the port stream', () async {
      late void Function(LiveKitRoomSignal) emit;
      final port = SdkLiveKitRoomPort(
        openRoom: (url, token, e) async {
          emit = e;
          return _FakeLiveRoom();
        },
      );
      final events = <LiveKitRoomSignal>[];
      port.signals.listen(events.add);

      await port.connect('wss://x', 'tok');
      emit(
        LiveKitRemoteParticipants(
          LiveRemoteParticipants(
            Map.unmodifiable({
              'u-1': const LiveRemoteParticipant(
                identity: 'u-1',
                audio: LiveRemoteAudio.live,
              ),
            }),
          ),
        ),
      );
      await pumpEventQueue();

      expect(events.single, isA<LiveKitRemoteParticipants>());
      final sig = events.single as LiveKitRemoteParticipants;
      expect(sig.participants['u-1']?.audio, LiveRemoteAudio.live);
      await port.dispose();
    });

    test('an active-speaker audio-levels signal surfaces on the port stream', () async {
      late void Function(LiveKitRoomSignal) emit;
      final port = SdkLiveKitRoomPort(
        openRoom: (url, token, e) async {
          emit = e;
          return _FakeLiveRoom();
        },
      );
      final events = <LiveKitRoomSignal>[];
      port.signals.listen(events.add);

      await port.connect('wss://x', 'tok');
      emit(const LiveKitAudioLevels(LiveAudioLevels({'u-host': 0.42})));
      await pumpEventQueue();

      expect(events.single, isA<LiveKitAudioLevels>());
      final sig = events.single as LiveKitAudioLevels;
      expect(sig.levels.levelFor('u-host'), 0.42);
      expect(sig.levels.levelFor('someone-else'), 0, reason: 'absent ⇒ 0');
      await port.dispose();
    });
  });

  group('remoteAudioState (SDK-free rule)', () {
    test('no track → none; unsubscribed → unsubscribed; muted → muted; else live', () {
      expect(
        remoteAudioState(hasMic: false, subscribed: false, muted: false),
        LiveRemoteAudio.none,
      );
      expect(
        remoteAudioState(hasMic: false, subscribed: true, muted: true),
        LiveRemoteAudio.none,
        reason: 'no mic track overrides everything',
      );
      expect(
        remoteAudioState(hasMic: true, subscribed: false, muted: false),
        LiveRemoteAudio.unsubscribed,
      );
      expect(
        remoteAudioState(hasMic: true, subscribed: true, muted: true),
        LiveRemoteAudio.muted,
      );
      expect(
        remoteAudioState(hasMic: true, subscribed: true, muted: false),
        LiveRemoteAudio.live,
      );
    });
  });
}
