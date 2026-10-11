import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/media/livekit/livekit_room_port.dart';

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

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async {}

  @override
  Future<void> setScreenShareEnabled(
    bool enabled, {
    bool captureScreenAudio = false,
  }) async {}

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
}
