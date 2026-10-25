import 'refresh_lock.dart';

/// Off the web one process owns the stored tokens, and `ApiClient`'s
/// single-flight already shares one refresh between its callers.
RefreshLock platformRefreshLock() => const InProcessRefreshLock();
