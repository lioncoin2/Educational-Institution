/// The parts of an invitation link that need no browser: where a link
/// points, what in an address is a token, and how one is taken out of the
/// address bar — written against [InviteAddressBar], so they run (and are
/// tested) on the Dart VM. The browser itself is `invite_link_web.dart`.
///
/// A link is `<the web app's base href>invite#<token>`. The token rides in
/// the fragment, which browsers never send to any server, and it is taken
/// out of the address bar the moment it is read: a token must not linger in
/// history, a bookmark, or anything copied from the page.
library;

/// The token in an address, if it is an invitation's: [pathname] is exactly
/// `invite` (a trailing slash tolerated) relative to [baseHref] — the very
/// address [inviteLinkFrom] writes — and [hash] is `#` and something more.
/// Whether that something has a token's shape is not asked here.
String? inviteTokenFrom({
  required String baseHref,
  required String pathname,
  required String hash,
}) {
  final base = Uri.tryParse(baseHref);
  if (base == null) return null;
  final invite = base.resolve('invite').path;
  if (pathname != invite && pathname != '$invite/') return null;
  if (hash.length < 2 || !hash.startsWith('#')) return null;
  return hash.substring(1);
}

/// The link to an invitation, for an app served from [baseHref].
Uri inviteLinkFrom(String baseHref, String token) =>
    Uri.parse(baseHref).resolve('invite').replace(fragment: token);

/// The browser's address bar and its current history entry, as far as an
/// invitation needs them.
abstract interface class InviteAddressBar {
  /// Where the app is served from (`document.baseURI`); null if unknown.
  String? get baseHref;

  /// These three are `location`'s: the path, `?…` or empty, `#…` or empty.
  String get pathname;
  String get search;
  String get hash;

  /// The current history entry's state — the engine's, kept as it is.
  Object? get state;

  /// Rewrites the current entry's address, without navigating.
  void replaceState(Object? state, String url);

  /// Calls [listener] after every history navigation — one to a fragment
  /// alone included.
  void onPopState(void Function() listener);
}

/// Takes the invitation token out of [bar], if its address holds one: read,
/// then at once rubbed out of the address (the entry keeps its state, its
/// path and its query). Null, and nothing touched, when there is none.
String? takeInviteTokenFrom(InviteAddressBar bar) {
  final baseHref = bar.baseHref;
  if (baseHref == null) return null;
  final pathname = bar.pathname;
  final token = inviteTokenFrom(
    baseHref: baseHref,
    pathname: pathname,
    hash: bar.hash,
  );
  if (token == null) return null;
  bar.replaceState(bar.state, pathname + bar.search);
  return token;
}

/// Hands [onToken] every token a later navigation brings — a link opened
/// while the app is already on its invite page changes only the fragment,
/// which reloads nothing — taken out of the address as [takeInviteTokenFrom]
/// does.
void listenForInviteTokensOn(
  InviteAddressBar bar,
  void Function(String token) onToken,
) {
  bar.onPopState(() {
    final token = takeInviteTokenFrom(bar);
    if (token != null) onToken(token);
  });
}
