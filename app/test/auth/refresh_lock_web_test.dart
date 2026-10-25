@TestOn('browser')
library;

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/api/refresh_lock.dart';

/// The web [RefreshLock] runs on the browser's real Web Locks API (the lock
/// every tab of the origin shares). Run with:
///   flutter test --platform chrome test/auth/refresh_lock_web_test.dart
void main() {
  test('the web build uses the browser lock, not the in-process one', () {
    expect(platformRefreshLock(), isNot(isA<InProcessRefreshLock>()));
  });

  test('two refreshes never overlap: the second starts after the first ends', () async {
    final lock = platformRefreshLock();
    final events = <String>[];
    final firstStarted = Completer<void>();
    final firstMayFinish = Completer<void>();
    // Never leave the lock held if an expectation fails.
    addTearDown(() {
      if (!firstMayFinish.isCompleted) firstMayFinish.complete();
    });

    final first = lock.run(() async {
      events.add('first:start');
      firstStarted.complete();
      await firstMayFinish.future;
      events.add('first:end');
      return 1;
    });
    final second = lock.run(() async {
      events.add('second:start');
      return 2;
    });

    // Wait for the browser to grant the first (its timing varies with load),
    // then give the second every chance to (wrongly) run alongside it.
    await firstStarted.future;
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(events, ['first:start'], reason: 'the second waits for the lock');
    firstMayFinish.complete();
    expect(await Future.wait([first, second]), [1, 2]);
    expect(events, ['first:start', 'first:end', 'second:start']);
  });

  test('a failing body releases the lock and its error reaches the caller', () async {
    final lock = platformRefreshLock();
    await expectLater(
      lock.run<int>(() async => throw StateError('refresh failed')),
      throwsA(isA<StateError>()),
    );
    expect(await lock.run(() async => 'next'), 'next');
  });
}
