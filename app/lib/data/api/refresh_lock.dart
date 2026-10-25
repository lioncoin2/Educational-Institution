/// Serializes the session REFRESH across every copy of the app that shares the
/// stored tokens.
///
/// Why this exists: the server rotates refresh tokens and treats one presented
/// twice as stolen — it ends the whole session. One app process already shares
/// a single refresh between its callers (`ApiClient`'s single-flight), but on
/// the web every tab of the site reads the SAME stored tokens (the secure store
/// is the origin's `localStorage`) while running its own client. Two tabs whose
/// access token expires together (their realtime sockets renew 60 s before the
/// same expiry) used to refresh in the same instant: the first rotated, the
/// second was taken for a thief, and both were signed out (audited by the
/// server as `refresh_reuse_detected` / `concurrent`).
///
/// On the web the browser's Web Locks API holds the refresh to one tab at a
/// time, and the next tab, once it gets the lock, finds the tokens already
/// renewed instead of presenting the spent one. Everywhere else (native, a test
/// on the VM) there is one process, so [platformRefreshLock] runs the body
/// directly. Swapped in by conditional import, as `screen_capture_support` is.
library;

import 'refresh_lock_stub.dart'
    if (dart.library.js_interop) 'refresh_lock_web.dart'
    as platform;

/// Runs a refresh while holding a lock shared with every other app instance
/// that reads the same stored tokens.
abstract interface class RefreshLock {
  Future<T> run<T>(Future<T> Function() body);
}

/// No other instance to coordinate with: runs [body] straight away.
class InProcessRefreshLock implements RefreshLock {
  const InProcessRefreshLock();

  @override
  Future<T> run<T>(Future<T> Function() body) => body();
}

/// The lock for this platform: the browser's cross-tab lock on the web (when the
/// browser offers one), [InProcessRefreshLock] otherwise.
RefreshLock platformRefreshLock() => platform.platformRefreshLock();
