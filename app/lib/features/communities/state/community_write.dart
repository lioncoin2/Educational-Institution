import '../../../data/models/communities.dart';

/// What became of one request to change something in a community — what a
/// screen acts on: say why not, go somewhere, or show a new link once.
///
/// Every change is one request, sent once: nothing here ever sends it again
/// on its own (a new link is not idempotent), and a tap that comes while the
/// same request is on its way sends nothing.
sealed class WriteOutcome<T> {
  const WriteOutcome();
}

/// The server did it. [value] is the part of its answer the screen needs.
final class WriteDone<T> extends WriteOutcome<T> {
  const WriteDone(this.value);

  final T value;
}

/// The server refused, or no answer came: nothing is known to have changed.
/// [error] carries the server's code, which the screen says in words.
final class WriteFailed<T> extends WriteOutcome<T> {
  const WriteFailed(this.error);

  final CommunityException error;
}

/// Nothing was sent: the same request is already on its way, or there is
/// nothing (yet) to act on.
final class WriteNotSent<T> extends WriteOutcome<T> {
  const WriteNotSent();
}

/// Whether [error] is the server's answer about the community as it now
/// stands — a refusal, or an answer this app could not read — rather than
/// no answer at all (unreachable, signed out), a server that could not serve
/// the request just now (unavailable, a rate limit), or a request it would
/// not take in that shape. After such an answer what the screens show is
/// read again, so what they offer follows the server's `me` as it is now: a
/// right taken back takes its button with it.
bool answersForTheCommunity(CommunityException error) =>
    !(error.isNetwork ||
        error.needsSignIn ||
        error.isUnavailable ||
        error.isRateLimited ||
        error.code == 'bad_request');
