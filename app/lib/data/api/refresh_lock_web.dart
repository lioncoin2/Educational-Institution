import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart' as web;

import 'refresh_lock.dart';

/// The browser's Web Locks API when it is available (every current browser in
/// a secure context), else the in-process lock — the same behaviour the app had
/// before, never a failure.
RefreshLock platformRefreshLock() {
  try {
    final navigator = web.window.navigator as JSObject;
    if (navigator.has('locks')) return const _WebLocksRefreshLock();
  } catch (_) {
    // No navigator (a worker) or a locked-down context: fall through.
  }
  return const InProcessRefreshLock();
}

/// One exclusive lock, by name, for every tab of the origin.
class _WebLocksRefreshLock implements RefreshLock {
  const _WebLocksRefreshLock();

  static const _name = 'quran-institution.auth-refresh';

  @override
  Future<T> run<T>(Future<T> Function() body) async {
    late T result;
    Object? failure;
    StackTrace? trace;
    // The lock is held until the promise the callback returns settles, so the
    // whole refresh — request AND the write of the new tokens — runs inside it.
    JSPromise<JSAny?> held(JSAny? _) => () async {
      try {
        result = await body();
      } catch (error, stackTrace) {
        failure = error;
        trace = stackTrace;
      }
    }().toJS;
    await web.window.navigator.locks.request(_name, held.toJS).toDart;
    if (failure != null) Error.throwWithStackTrace(failure!, trace!);
    return result;
  }
}
