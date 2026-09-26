import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/invite_link.dart';
import 'package:quran_institution_app/app/invite_link_parts.dart';
import 'package:quran_institution_app/app/invite_link_web.dart' as browser;

/// Invitation links on the web: `<base href>invite#<token>` — what is a
/// token in an address, where a link points, and a token rubbed out of the
/// address bar as soon as it is read, before anything else can see it.
void main() {
  const token = 'tok_123';

  group('a token in an address', () {
    String? take(String baseHref, String pathname, String hash) =>
        inviteTokenFrom(baseHref: baseHref, pathname: pathname, hash: hash);

    test('is the fragment of the invite page, for an app at the root', () {
      const base = 'https://example.org/';
      expect(take(base, '/invite', '#$token'), token);
      expect(take(base, '/invite/', '#$token'), token);
      expect(take('/', '/invite', '#$token'), token);
    });

    test('is the fragment of the invite page, for an app under a path', () {
      const base = 'https://owner.github.io/repo/';
      expect(take(base, '/repo/invite', '#$token'), token);
      expect(take(base, '/repo/invite/', '#$token'), token);
      // Not the invite page of this app.
      expect(take(base, '/invite', '#$token'), isNull);
      expect(take(base, '/other/invite', '#$token'), isNull);
    });

    test('is nothing on any other page', () {
      const base = 'https://owner.github.io/repo/';
      for (final pathname in [
        '/repo/',
        '/repo',
        '/repo/communities',
        '/repo/invite/x',
        '/repo/invite/x/',
        '/repo/invites',
        '/repo/Invite',
        '/repo/invite//',
        '/repo/%69nvite',
        '/repo/communities/invite',
      ]) {
        expect(take(base, pathname, '#$token'), isNull, reason: pathname);
      }
    });

    test('is nothing without a fragment, or with an empty one', () {
      const base = 'https://example.org/';
      for (final hash in ['', '#', token]) {
        expect(take(base, '/invite', hash), isNull, reason: hash);
      }
    });

    test('is whatever follows the #: its shape is asked elsewhere', () {
      const base = 'https://example.org/';
      expect(take(base, '/invite', '#a#b'), 'a#b');
      expect(take(base, '/invite', '#%20x'), '%20x');
    });

    test('ignores a query: the path alone says which page it is', () {
      // `location.pathname` never holds the query; the address bar keeps it.
      const base = 'https://example.org/repo/?v=2#top';
      expect(take(base, '/repo/invite', '#$token'), token);
    });

    test('is nothing when the base address cannot be read', () {
      expect(take('http://[::1', '/invite', '#$token'), isNull);
    });
  });

  group('a link', () {
    test('points at the invite page of the app, the token its fragment', () {
      expect(
        inviteLinkFrom('https://example.org/', token).toString(),
        'https://example.org/invite#$token',
      );
      expect(
        inviteLinkFrom('https://owner.github.io/repo/', token).toString(),
        'https://owner.github.io/repo/invite#$token',
      );
    });

    test('drops whatever query or fragment the base address had', () {
      expect(
        inviteLinkFrom('https://example.org/repo/?v=2#top', token).toString(),
        'https://example.org/repo/invite#$token',
      );
    });

    test('is read back as the same token, wherever the app is served', () {
      const realToken = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
      for (final base in [
        'https://example.org/',
        'https://owner.github.io/repo/',
        'https://example.org/a/b/',
        // Without a trailing slash, the base's directory is where it points.
        'https://example.org/app',
      ]) {
        final link = inviteLinkFrom(base, realToken);
        expect(
          inviteTokenFrom(
            baseHref: base,
            pathname: link.path,
            hash: '#${link.fragment}',
          ),
          realToken,
          reason: base,
        );
      }
    });
  });

  group('taking a token out of the address bar', () {
    test('reads it, then at once rewrites the address without it', () {
      final bar = _AddressBar(
        pathname: '/repo/invite',
        search: '?from=mail',
        hash: '#$token',
      );
      expect(takeInviteTokenFrom(bar), token);
      expect(bar.replaced, hasLength(1));
      final (state, url) = bar.replaced.single;
      // The history entry keeps its state object — the engine's — as it was.
      expect(state, same(bar.state));
      expect(url, '/repo/invite?from=mail');
      expect(bar.hash, isEmpty);
    });

    test('touches nothing when the address holds no token', () {
      for (final bar in [
        _AddressBar(pathname: '/repo/communities', hash: '#$token'),
        _AddressBar(pathname: '/repo/invite', hash: ''),
        _AddressBar(pathname: '/repo/invite', hash: '#$token', baseHref: null),
      ]) {
        expect(takeInviteTokenFrom(bar), isNull);
        expect(bar.replaced, isEmpty);
      }
    });

    test('takes each later one a navigation brings, and nothing else', () {
      final bar = _AddressBar(pathname: '/repo/invite', hash: '');
      final offered = <String>[];
      listenForInviteTokensOn(bar, offered.add);
      expect(offered, isEmpty); // listening reads nothing yet

      // A link opened while already on the invite page: the fragment alone.
      bar.navigate(pathname: '/repo/invite', hash: '#second');
      expect(offered, ['second']);
      expect(bar.hash, isEmpty);
      expect(bar.replaced.single.$2, '/repo/invite');

      // Back and forth between pages: nothing.
      bar.navigate(pathname: '/repo/communities', hash: '');
      bar.navigate(pathname: '/repo/invite', hash: '');
      bar.navigate(pathname: '/repo/communities', hash: '#third');
      expect(offered, ['second']);
      expect(bar.replaced, hasLength(1));

      // The same link again is offered again.
      bar.navigate(pathname: '/repo/invite/', hash: '#second');
      expect(offered, ['second', 'second']);
    });
  });

  group('outside a browser', () {
    test('there is never a token, and never a link', () {
      expect(takeInviteToken(), isNull);
      expect(inviteLinkFor(token), isNull);
      var offered = false;
      listenForInviteTokens((_) => offered = true);
      expect(offered, isFalse);
    });

    test('the browser’s own implementation finds no address to read', () {
      // Off the web, Flutter's BrowserPlatformLocation is an empty stand-in:
      // no base address, so no token and no link — never a guess.
      expect(browser.takeInviteToken(), isNull);
      expect(browser.inviteLinkFor(token), isNull);
      browser.listenForInviteTokens((_) => fail('no navigation here'));
    });
  });
}

/// An address bar that records what is done to it.
class _AddressBar implements InviteAddressBar {
  _AddressBar({
    required this.pathname,
    required this.hash,
    this.search = '',
    this.baseHref = 'https://owner.github.io/repo/',
  });

  @override
  final String? baseHref;

  @override
  String pathname;

  @override
  String search;

  @override
  String hash;

  @override
  final Object state = {'serialCount': 3.0, 'state': null};

  final List<(Object?, String)> replaced = [];
  final List<void Function()> _listeners = [];

  @override
  void replaceState(Object? state, String url) {
    replaced.add((state, url));
    final uri = Uri.parse(url);
    pathname = uri.path;
    search = uri.hasQuery ? '?${uri.query}' : '';
    hash = uri.hasFragment ? '#${uri.fragment}' : '';
  }

  @override
  void onPopState(void Function() listener) => _listeners.add(listener);

  /// A navigation within the page, as the browser reports it.
  void navigate({required String pathname, required String hash}) {
    this.pathname = pathname;
    this.hash = hash;
    for (final listener in _listeners) {
      listener();
    }
  }
}
