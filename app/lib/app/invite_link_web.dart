/// The page the web app runs in, read and rewritten through the engine's
/// [BrowserPlatformLocation] — no `dart:html`, no package beyond Flutter's.
library;

import 'package:flutter_web_plugins/url_strategy.dart';

import 'invite_link_parts.dart';

/// The token of the link the page was opened with, taken out of the address
/// bar as it is read. Must run in `main()` before `runApp`: building the
/// router makes the engine rewrite the address without its fragment.
String? takeInviteToken() => takeInviteTokenFrom(_AddressBar());

/// Hands [onToken] each token a later navigation brings. Must be registered
/// in `main()` before `runApp`, so it runs before the engine's own popstate
/// listener, registered once the router is built.
void listenForInviteTokens(void Function(String token) onToken) =>
    listenForInviteTokensOn(_AddressBar(), onToken);

/// The link to an invitation with [token], at this web app's own address —
/// null when the page has no base address to resolve against.
Uri? inviteLinkFor(String token) {
  final baseHref = _AddressBar().baseHref;
  return baseHref == null ? null : inviteLinkFrom(baseHref, token);
}

class _AddressBar implements InviteAddressBar {
  // Not `const`: the stand-in the analyzer and the VM see has no const
  // constructor, only the browser's does.
  final _location = BrowserPlatformLocation();

  @override
  String? get baseHref => _location.getBaseHref();

  @override
  String get pathname => _location.pathname;

  @override
  String get search => _location.search;

  @override
  String get hash => _location.hash;

  @override
  Object? get state => _location.state;

  @override
  void replaceState(Object? state, String url) =>
      _location.replaceState(state, '', url);

  @override
  void onPopState(void Function() listener) =>
      _location.addPopStateListener((_) => listener());
}
