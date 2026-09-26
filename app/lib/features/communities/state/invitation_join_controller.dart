import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/communities.dart';
import '../../../providers/app_providers.dart';
import 'community_list_controller.dart';
import 'community_write.dart';
import 'pending_invitation.dart';

/// Where the invitation link the app was handed stands, as the invite
/// screen shows it. No state holds the token: it stays in the one holder
/// (pendingInvitationProvider), read at the moment it is sent.
sealed class InvitationJoinState {
  const InvitationJoinState();
}

/// Nothing to open: no link was given — or the one given was used, or
/// turned down for good.
final class NoInvitation extends InvitationJoinState {
  const NoInvitation();
}

/// A link to answer, with one tap.
final class OpenInvitation extends InvitationJoinState {
  const OpenInvitation({
    required this.serial,
    this.joining = false,
    this.failure,
    this.signInNeeded = false,
  });

  /// Which offer this is (see [PendingInvitation.serial]).
  final int serial;

  /// The request to join is on its way.
  final bool joining;

  /// Why the last request did not go through — something passing: no
  /// connection, the server busy, too many attempts, a change at the same
  /// moment. The link is kept, to be sent again on request.
  final CommunityException? failure;

  /// The server asked for a sign-in: the link is kept across it.
  final bool signInNeeded;
}

/// Used: the viewer is in [community] — joined just now or a member
/// already; the server's two answers are told alike.
final class JoinedInvitation extends InvitationJoinState {
  const JoinedInvitation(this.community);

  final Community community;
}

/// Not usable, and forgotten: [code] is the server's refusal for good — or
/// null when what was given has no token's shape, and nothing was sent.
final class ClosedInvitation extends InvitationJoinState {
  const ClosedInvitation(this.code);

  final String? code;
}

/// The invite screen: the link the app was handed, and what became of it.
///
/// A link alone never enrolls anyone. Joining is the viewer's tap: one
/// request (POST /communities/join, the token in its body), one at a time,
/// never sent again on its own — and never for something without a token's
/// shape, which is forgotten on the spot. Done, the link is forgotten and
/// the list read again. Refused for good (a link not valid, revoked,
/// expired or used up; a way back that is not by link; a community not
/// taking anyone), it is forgotten too; anything passing keeps it for an
/// explicit retry, and a request for a sign-in keeps it across one.
///
/// A link opened while the screen is up — even the same one again — starts
/// it over with that link. The screen's state lives as long as the screen:
/// back on it after the link was used, there is nothing to open.
class InvitationJoinController extends Notifier<InvitationJoinState> {
  /// Refusals no second request can change.
  static const _refusedForGood = {
    'communities.invitation_invalid',
    'communities.invitation_revoked',
    'communities.invitation_expired',
    'communities.invitation_exhausted',
    'communities.rejoin_requires_manager',
    'communities.community_locked',
  };

  @override
  InvitationJoinState build() {
    ref.listen<PendingInvitation?>(pendingInvitationProvider, (previous, next) {
      // The holder emptied is this controller's own doing: what it shows
      // stays. A new offer starts over.
      if (next != null && next.serial != previous?.serial) {
        state = _open(next);
      }
    });
    final pending = ref.read(pendingInvitationProvider);
    return pending == null ? const NoInvitation() : _open(pending);
  }

  /// Sends the link: one request. Done carries the community as the viewer
  /// now stands in it; the screen goes there.
  Future<WriteOutcome<Community>> join() async {
    final shown = state;
    final pending = ref.read(pendingInvitationProvider);
    if (shown is! OpenInvitation ||
        shown.joining ||
        pending == null ||
        pending.serial != shown.serial ||
        !pending.isWellFormed) {
      return const WriteNotSent();
    }
    final serial = pending.serial;
    // Seen through to the end, even if the screen is left meanwhile: a link
    // used is forgotten either way.
    final alive = ref.keepAlive();
    state = OpenInvitation(serial: serial, joining: true);
    try {
      final Community community;
      try {
        community = await ref
            .read(communityRepositoryProvider)
            .join(pending.token);
      } on CommunityException catch (error) {
        if (ref.mounted) _refused(serial, error);
        return WriteFailed(error);
      }
      if (ref.mounted) {
        _forget(serial);
        if (ref.exists(communityListProvider)) {
          unawaited(
            ref
                .read(communityListProvider.notifier)
                .reconcileJoined(community.id),
          );
        }
        if (_shows(serial)) state = JoinedInvitation(community);
      }
      return WriteDone(community);
    } finally {
      // Whatever else ended the request, the button is not left spinning.
      if (ref.mounted) {
        final shown = state;
        if (shown is OpenInvitation && shown.joining && _shows(serial)) {
          state = OpenInvitation(serial: serial);
        }
      }
      alive.close();
    }
  }

  /// The sign-in screen the link was waiting on closed again: the link is
  /// offered again, to whatever session there now is.
  void backFromSignIn() {
    final shown = state;
    if (shown is OpenInvitation && shown.signInNeeded) {
      state = OpenInvitation(serial: shown.serial);
    }
  }

  InvitationJoinState _open(PendingInvitation pending) {
    if (pending.isWellFormed) return OpenInvitation(serial: pending.serial);
    // No token's shape: no invitation at all. Nothing is sent for it, and it
    // is forgotten — once this build is over: no provider may change another
    // while it is being built.
    unawaited(Future.microtask(() => _forget(pending.serial)));
    return const ClosedInvitation(null);
  }

  void _refused(int serial, CommunityException error) {
    final forGood = _refusedForGood.contains(error.code);
    if (forGood) _forget(serial);
    // Another link was opened meanwhile: that one is what is shown.
    if (!_shows(serial)) return;
    state = forGood
        ? ClosedInvitation(error.code)
        : error.needsSignIn
        ? OpenInvitation(serial: serial, signInNeeded: true)
        : OpenInvitation(serial: serial, failure: error);
  }

  /// Empties the holder — if it still holds offer [serial], and not one
  /// made since.
  void _forget(int serial) {
    if (!ref.mounted) return;
    if (ref.read(pendingInvitationProvider)?.serial == serial) {
      ref.read(pendingInvitationProvider.notifier).clear();
    }
  }

  bool _shows(int serial) {
    final shown = state;
    return shown is OpenInvitation && shown.serial == serial;
  }
}

final invitationJoinProvider =
    NotifierProvider.autoDispose<InvitationJoinController, InvitationJoinState>(
      InvitationJoinController.new,
      retry: (_, _) => null,
    );
