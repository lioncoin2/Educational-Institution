import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/communities.dart';

/// An invitation link the app was opened with — or handed while running —
/// and has not yet acted on.
///
/// Its token is a secret: whoever holds it may join. It lives in memory
/// only, in this one place — never a route, a query or `extra`, never
/// storage, never a log — and [toString] leaves it out.
class PendingInvitation {
  const PendingInvitation({required this.serial, required this.token});

  /// Which offer this is. A link opened again — even the same one — is a
  /// new offer with a higher serial, so whatever showed the older one starts
  /// over.
  final int serial;

  /// Sent once, in the body of the request to join.
  final String token;

  /// Whether [token] has a token's shape at all. One that has not is no
  /// invitation: nothing is sent for it.
  bool get isWellFormed => isInvitationTokenShaped(token);

  @override
  String toString() => 'PendingInvitation(#$serial)';
}

/// The token of the link the page was opened with — taken from the address
/// bar in `main()`, before the app started — or null. main() overrides it;
/// the holder alone reads it, once.
final startupInvitationTokenProvider = Provider<String?>((ref) => null);

/// The tokens of links opened while the app runs: on the web, a link to the
/// invite page opened while already on it, which changes only the address's
/// fragment. main() overrides it with the stream its browser listener feeds.
final laterInvitationTokensProvider = Provider<Stream<String>>(
  (ref) => const Stream<String>.empty(),
);

/// Holds at most one [PendingInvitation]: the latest offered — the startup
/// link's first, then each one opened later.
class PendingInvitationHolder extends Notifier<PendingInvitation?> {
  int _serial = 0;
  bool _startupTaken = false;

  @override
  PendingInvitation? build() {
    // Read, not watched: both are fixed for the app's life, and building
    // again — which nothing asks for — must not bring back a used token.
    final later = ref.read(laterInvitationTokensProvider).listen(offer);
    ref.onDispose(later.cancel);
    if (_startupTaken) return null;
    _startupTaken = true;
    final token = ref.read(startupInvitationTokenProvider);
    return token == null
        ? null
        : PendingInvitation(serial: ++_serial, token: token);
  }

  /// [token] is now the pending invitation, in place of any other.
  void offer(String token) =>
      state = PendingInvitation(serial: ++_serial, token: token);

  /// Nothing is pending any more: the invitation was used, refused for
  /// good, or was never one.
  void clear() => state = null;
}

final pendingInvitationProvider =
    NotifierProvider<PendingInvitationHolder, PendingInvitation?>(
      PendingInvitationHolder.new,
    );
