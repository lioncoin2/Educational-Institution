import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_avatar.dart';
import '../../../data/models/live.dart';
import '../../../data/models/live_media.dart';
import '../../../providers/app_providers.dart';
import '../live_copy.dart';
import '../state/live_media_controller.dart';

/// The LIVE presence roster — who is actually connected to the session's media
/// room now, from LiveKit (the only source that knows): every participant is
/// visible (no hidden listeners, ADR 0027) and each token carries a display
/// name, so names + mic state are real, never fabricated.
///
/// PRIVACY: a connected COUNT is shown to everyone; the NAMED roster is shown to
/// MODERATORS only — the app policy on exposing a named presence list to
/// listeners is deferred (backend `contracts/presence.ts`, Q68), so this stays
/// conservative until the owner decides. ROLES are shown only where provable:
/// the host (`session.hostUserId`), presenters (`session.presenterUserIds`), the
/// viewer's own role (`me`), and the server's "may speak" grant (`canSpeak`).
/// Others are never labelled with an invented role.
///
/// The roster is populated only while the viewer is CONNECTED to the audio room
/// (LiveKit has no roster otherwise); a prompt says so when idle.
class LivePresenceList extends ConsumerWidget {
  const LivePresenceList({super.key, required this.session});

  final LiveSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final remotes =
        ref.watch(liveRemoteParticipantsProvider).value?.values.toList() ??
        const <LiveRemoteParticipant>[];
    final mediaState = ref.watch(liveMediaProvider(session.id));
    final connected =
        mediaState is LiveMediaConnected || mediaState is LiveMediaReconnecting;
    final selfId = ref.watch(sessionUserProvider.select((s) => s.value?.id));
    final canSeeNames = session.me.canModerate;
    final total = remotes.length + (connected ? 1 : 0);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Icon(Icons.groups_rounded, size: 20, color: context.colors.primary),
            const SizedBox(width: Insets.sm),
            Expanded(
              child: Text(
                LiveCopy.presenceTitle,
                style: context.text.titleMedium,
              ),
            ),
            Text(
              LiveCopy.presenceCount(total),
              style: context.text.labelSmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ],
        ),
        const SizedBox(height: Insets.md),
        if (!connected)
          const _Hint(LiveCopy.presenceJoinToSee)
        else if (!canSeeNames) ...[
          _SelfRow(session: session),
          const SizedBox(height: Insets.sm),
          const _Hint(LiveCopy.presenceNamesModerators),
        ] else ...[
          _SelfRow(session: session),
          ..._named(remotes, selfId),
          if (remotes.isEmpty) const _Hint(LiveCopy.presenceEmpty),
        ],
      ],
    );
  }

  List<Widget> _named(List<LiveRemoteParticipant> remotes, String? selfId) {
    bool isSpeaker(LiveRemoteParticipant p) =>
        p.canSpeak ||
        p.identity == session.hostUserId ||
        session.presenterUserIds.contains(p.identity);
    // Self is shown by _SelfRow; it is never in room.remoteParticipants, but
    // guard anyway.
    final others = [
      for (final p in remotes)
        if (p.identity != selfId) p,
    ];
    final speakers = [
      for (final p in others)
        if (isSpeaker(p)) p,
    ];
    final listeners = [
      for (final p in others)
        if (!isSpeaker(p)) p,
    ];
    return [
      if (speakers.isNotEmpty) ...[
        const SizedBox(height: Insets.md),
        const _SectionLabel(LiveCopy.sectionSpeakers),
        for (final p in speakers)
          _ParticipantPresenceRow(session: session, participant: p),
      ],
      if (listeners.isNotEmpty) ...[
        const SizedBox(height: Insets.md),
        const _SectionLabel(LiveCopy.sectionListeners),
        for (final p in listeners)
          _ParticipantPresenceRow(session: session, participant: p),
      ],
    ];
  }
}

/// The viewer's own row — always shown when connected. The label is «أنت»; the
/// role is the server's `me`, and the mic is the SDK-reconciled publication.
class _SelfRow extends ConsumerWidget {
  const _SelfRow({required this.session});

  final LiveSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = session.me;
    final micOn =
        ref.watch(liveMediaPublicationProvider).value?.microphoneOn ?? false;
    final role = me.isHost
        ? LiveCopy.roleHost
        : me.canModerate
        ? LiveCopy.roleModerator
        : me.role == LiveParticipantRole.speaker
        ? LiveCopy.roleSpeaker
        : LiveCopy.roleListener;
    return _Row(
      name: LiveCopy.youLabel,
      role: role,
      roleTone: _RoleTone.self,
      micOn: micOn,
      micMuted: !micOn,
    );
  }
}

/// One remote participant's presence row.
class _ParticipantPresenceRow extends StatelessWidget {
  const _ParticipantPresenceRow({
    required this.session,
    required this.participant,
  });

  final LiveSession session;
  final LiveRemoteParticipant participant;

  @override
  Widget build(BuildContext context) {
    final isHost = participant.identity == session.hostUserId;
    final isPresenter = session.presenterUserIds.contains(participant.identity);
    final name = (participant.name != null && participant.name!.isNotEmpty)
        ? participant.name!
        : LiveCopy.participantFallback;
    final role = isHost
        ? LiveCopy.roleHost
        : isPresenter
        ? LiveCopy.presenterBadge
        : null;
    return _Row(
      name: name,
      role: role,
      roleTone: _RoleTone.other,
      micOn: participant.audio == LiveRemoteAudio.live,
      micMuted: participant.audio == LiveRemoteAudio.muted,
    );
  }
}

enum _RoleTone { self, other }

/// The shared row layout: avatar, name, optional role chip, and a mic icon that
/// reflects the real published/muted state (nothing is shown when there is no
/// audible/known mic track).
class _Row extends StatelessWidget {
  const _Row({
    required this.name,
    required this.role,
    required this.roleTone,
    required this.micOn,
    required this.micMuted,
  });

  final String name;
  final String? role;
  final _RoleTone roleTone;
  final bool micOn;
  final bool micMuted;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.xs),
      child: Row(
        children: [
          AppAvatar(name: name, radius: 16),
          const SizedBox(width: Insets.md),
          Expanded(child: Text(name, style: context.text.titleSmall)),
          if (role != null) ...[
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: Insets.sm,
                vertical: Insets.xs,
              ),
              decoration: BoxDecoration(
                color: roleTone == _RoleTone.self
                    ? colors.primaryContainer
                    : colors.secondaryContainer,
                borderRadius: Radii.pill,
              ),
              child: Text(
                role!,
                style: context.text.labelSmall?.copyWith(
                  color: roleTone == _RoleTone.self
                      ? colors.onPrimaryContainer
                      : colors.onSecondaryContainer,
                ),
              ),
            ),
            const SizedBox(width: Insets.sm),
          ],
          if (micOn)
            Icon(Icons.mic_rounded, size: 18, color: colors.primary)
          else if (micMuted)
            Icon(Icons.mic_off_rounded, size: 18, color: colors.error),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: Insets.xs),
      child: Text(
        label,
        style: context.text.labelLarge?.copyWith(
          color: context.colors.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(text, style: context.text.bodySmall);
  }
}
