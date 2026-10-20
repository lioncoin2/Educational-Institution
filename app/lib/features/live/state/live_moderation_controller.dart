import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/live.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';

/// The viewer's commands on a live session — a moderator's (end it, remove a
/// participant, reset the room, the screen-share grants, and granting/declining/
/// revoking the floor, Q56/Q64), and the viewer's own (claim/stop a presenter
/// slot, raise/lower their hand).
///
/// It only orchestrates: each method forwards to [LiveRepository] and hands
/// back the server's own answer. It is deliberately NOT where state lives. A
/// command never touches the session the screen shows — the server, having
/// acted, emits the realtime fact and the live session controller re-reads the
/// authoritative session (Slice 4); a floor command additionally prompts the
/// roster to re-read. So nothing here is optimistic: no presenter list, hand,
/// role, count or version is changed in the app, and no "it probably worked"
/// session is fabricated.
///
/// Authorization is the server's alone. A screen may use the session's `me.can*`
/// to decide whether to show a control, but every command still goes to the
/// backend, which decides afresh; this layer recomputes nothing and, on a
/// refusal, lets the repository's [LiveException] through unchanged (403, 404,
/// 409 `live.presenter_slots_full`, 412, 503 — the server's code, surfaced).
///
/// The floor permits speaking (audio); the audio itself is the media seam,
/// unavailable in this build — granting the floor is a standing the server
/// tracks, never a claim that audio flows.
class LiveModerationController {
  const LiveModerationController(this._live);

  final LiveRepository _live;

  /// Ends the session (any of its moderators). Returns the session as the
  /// server now sees it; ending an ended session succeeds too.
  Future<LiveSession> endSession(String sessionId) =>
      _live.endSession(sessionId);

  /// Removes [userId] from the session's media room (Q64) — an administrative
  /// disconnect, never a ban. [reason] is an optional short code the server
  /// validates. `true` when they were connected and removed.
  Future<bool> removeParticipant(
    String sessionId,
    String userId, {
    String? reason,
  }) => _live.removeParticipant(sessionId, userId, reason: reason);

  /// Resets the session's media room (Q64). `true` when this call moved it on.
  Future<bool> resetRoom(String sessionId) => _live.resetRoom(sessionId);

  /// The caller claims a screen-share slot for themselves (Q56).
  Future<LiveSession> claimPresenter(String sessionId) =>
      _live.claimPresenter(sessionId);

  /// The caller stops their own screen share (Q56).
  Future<LiveSession> stopPresenter(String sessionId) =>
      _live.stopPresenter(sessionId);

  /// A moderator grants [userId] a delegated screen-share slot (Q56).
  Future<LiveSession> grantPresenter(String sessionId, String userId) =>
      _live.grantPresenter(sessionId, userId);

  /// A moderator revokes [userId]'s screen-share grant (Q56).
  Future<LiveSession> revokePresenter(String sessionId, String userId) =>
      _live.revokePresenter(sessionId, userId);

  /// The viewer raises a hand — asks for the floor. Idempotent on the server.
  Future<LiveHand> raiseHand(String sessionId) => _live.raiseHand(sessionId);

  /// The viewer lowers their own hand, or yields the floor. Null when none was up.
  Future<LiveHand?> lowerHand(String sessionId) => _live.lowerHand(sessionId);

  /// A moderator gives the floor to the hand with [requestId] (from the roster).
  Future<LiveHand> grantFloor(String requestId) => _live.grantFloor(requestId);

  /// A moderator passes over the hand with [requestId], giving no floor.
  Future<LiveHand> declineHand(String requestId) =>
      _live.declineHand(requestId);

  /// A moderator takes the floor back from the speaker with [requestId].
  Future<LiveHand> revokeFloor(String requestId) =>
      _live.revokeFloor(requestId);
}

final liveModerationProvider = Provider<LiveModerationController>(
  (ref) => LiveModerationController(ref.watch(liveRepositoryProvider)),
);
