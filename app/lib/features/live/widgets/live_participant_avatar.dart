import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/widgets/foundations/app_avatar.dart';
import '../../../providers/app_providers.dart';

/// A live participant's picture link (ADR 0048) — identity's picture, linked
/// by Files, asked of the session for exactly the people the room names to the
/// viewer. Resolved once per (session, person) and shared by every place that
/// shows them while any of them is on screen, so a roster rebuild, a reconnect
/// or a realtime re-read never asks again. Null — no picture, not the
/// viewer's to see, or the read failed — is the initials view, never an error.
final liveParticipantAvatarProvider = FutureProvider.autoDispose
    .family<Uri?, ({String sessionId, String userId})>((ref, key) async {
      try {
        return await ref
            .watch(liveRoomRepositoryProvider)
            .participantAvatarUrl(key.sessionId, key.userId);
      } on Object {
        return null; // unreachable or refused: initials, quietly
      }
    }, retry: (_, _) => null);

/// One participant's avatar in the live room (C15): their real profile
/// picture where they have one, their initial otherwise — through [AppAvatar],
/// the one place a picture is drawn. The viewer's own picture comes from their
/// own account ([ownAvatarUrlProvider]), never asked of the session. Fixed
/// size from the first frame: the initials stay until the image has loaded,
/// so nothing shifts. Never a video tile — the camera is no source in this
/// platform, and a shared screen keeps the stage.
class LiveParticipantAvatar extends ConsumerWidget {
  const LiveParticipantAvatar({
    super.key,
    required this.sessionId,
    required this.userId,
    required this.name,
    this.radius = 18,
  });

  final String sessionId;

  /// The participant's account id (their media identity).
  final String userId;

  /// The name the initials come from (the server's, or a neutral fallback).
  final String? name;

  final double radius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selfId = ref.watch(sessionUserProvider.select((s) => s.value?.id));
    final url = userId == selfId
        ? ref.watch(ownAvatarUrlProvider).value
        : ref
              .watch(
                liveParticipantAvatarProvider((
                  sessionId: sessionId,
                  userId: userId,
                )),
              )
              .value;
    return AppAvatar(
      key: Key('live-avatar-$userId'),
      name: name,
      imageUrl: url,
      radius: radius,
    );
  }
}
