import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/live.dart';
import '../../../data/models/live_media.dart';
import '../../../data/models/live_room.dart';
import '../../../providers/app_providers.dart';
import '../live_copy.dart';
import '../state/live_media_controller.dart';
import '../state/live_moderation_controller.dart';
import 'live_controls.dart';
import 'live_moderation_actions.dart';
import 'live_reactions.dart';

/// The live room's bottom CONTROL DOCK (reference: a row of circular control
/// buttons under the stage): the viewer's own participation — joining the audio,
/// the microphone, a presenter's screen-share capture, raising/lowering the
/// hand, a quick reaction (ADR 0049), and (for a moderator) ending the
/// broadcast — plus the reference's camera as a LOCKED placeholder.
///
/// Media is TRANSPORT only, behind the seam (keyed per session through
/// [liveMediaProvider]); authority — who may join, present, raise a hand or end
/// — is the server's `me`, never worked out here. Two product rules hold:
/// joining is EXPLICIT (a tap, except the banner's one-shot auto-join) and never
/// opens the microphone. A compact status strip above the dock says where the
/// connection stands and what the SDK has actually published.
class LiveMediaPanel extends ConsumerStatefulWidget {
  const LiveMediaPanel({super.key, required this.session, this.autoJoin = false});

  final LiveSession session;

  /// Connect to the session audio automatically on first build — the live
  /// banner's Telegram-style direct join. Never opens the microphone, never
  /// joins where `me.canJoin` is false or no provider is bound, and at most once.
  final bool autoJoin;

  @override
  ConsumerState<LiveMediaPanel> createState() => _LiveMediaPanelState();
}

class _LiveMediaPanelState extends ConsumerState<LiveMediaPanel> {
  String get _sessionId => widget.session.id;
  bool get _presenting => widget.session.me.presenting;

  bool _autoJoinTried = false;
  bool _micBusy = false;
  bool _screenBusy = false;
  bool _handBusy = false;
  bool _endBusy = false;

  LiveMediaController get _media =>
      ref.read(liveMediaProvider(_sessionId).notifier);
  LiveModerationController get _moderation =>
      ref.read(liveModerationProvider);
  LiveMediaPublication get _publication =>
      ref.read(liveMediaPublicationProvider).value ??
      const LiveMediaPublication();

  @override
  void initState() {
    super.initState();
    if (widget.autoJoin) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _maybeAutoJoin());
    }
  }

  /// One-shot auto-join (the banner). A no-op when media is unavailable, the
  /// viewer may not join, a connect is already past idle, or it already ran.
  void _maybeAutoJoin() {
    if (_autoJoinTried || !mounted) return;
    final state = ref.read(liveMediaProvider(_sessionId));
    if (state is LiveMediaIdle && widget.session.me.canJoin) {
      _autoJoinTried = true;
      unawaited(
        _media
            .connect(communityId: widget.session.communityId)
            .catchError((_) {}),
      );
    }
  }

  @override
  void didUpdateWidget(LiveMediaPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Losing the presenter slot on the SAME session stops the capture too (the
    // backend already drops the track server-side). Best-effort.
    if (oldWidget.session.id == _sessionId &&
        oldWidget.session.me.presenting &&
        !_presenting) {
      unawaited(_media.setScreenShareEnabled(false).catchError((_) {}));
    }
  }

  Future<void> _connect() async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await _media.connect(communityId: widget.session.communityId);
    } on LiveException catch (error) {
      if (mounted) messenger.toast(LiveCopy.commandError(error.code));
    } catch (_) {
      if (mounted) messenger.toast(LiveCopy.commandError(null));
    }
  }

  Future<void> _toggleMic() async {
    if (_micBusy) return;
    final messenger = ScaffoldMessenger.of(context);
    final next = !_publication.microphoneOn;
    setState(() => _micBusy = true);
    try {
      await _media.setMicrophoneEnabled(next);
    } on LiveMediaException catch (error) {
      if (mounted) {
        messenger.toast(
          error.code == 'microphone_blocked'
              ? LiveCopy.micBlocked
              : LiveCopy.micError,
        );
      }
    } catch (_) {
      if (mounted) messenger.toast(LiveCopy.micError);
    } finally {
      if (mounted) setState(() => _micBusy = false);
    }
  }

  Future<void> _toggleScreen() async {
    if (_screenBusy) return;
    final messenger = ScaffoldMessenger.of(context);
    final next = !_publication.screenShareOn;
    setState(() => _screenBusy = true);
    try {
      await _media.setScreenShareEnabled(next);
    } catch (_) {
      if (mounted) messenger.toast(LiveCopy.screenShareError);
    } finally {
      if (mounted) setState(() => _screenBusy = false);
    }
  }

  Future<void> _hand(bool active, bool granted) async {
    if (_handBusy) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _handBusy = true);
    try {
      if (active) {
        await _moderation.lowerHand(_sessionId);
        if (mounted) {
          messenger.toast(
            granted ? LiveCopy.yieldFloorDone : LiveCopy.lowerHandDone,
          );
        }
      } else {
        await _moderation.raiseHand(_sessionId);
        if (mounted) messenger.toast(LiveCopy.raiseHandDone);
      }
    } on LiveException catch (error) {
      if (mounted) messenger.toast(LiveCopy.commandError(error.code));
    } catch (_) {
      if (mounted) messenger.toast(LiveCopy.commandError(null));
    } finally {
      if (mounted) setState(() => _handBusy = false);
    }
  }

  Future<void> _end() async {
    if (_endBusy) return;
    final yes = await confirmLiveAction(
      context,
      question: LiveCopy.endSessionQuestion,
      confirmLabel: LiveCopy.endSessionConfirm,
      destructive: true,
    );
    if (!yes || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _endBusy = true);
    try {
      await _moderation.endSession(_sessionId);
      if (mounted) messenger.toast(LiveCopy.endSessionDone);
    } on LiveException catch (error) {
      if (mounted) messenger.toast(LiveCopy.commandError(error.code));
    } catch (_) {
      if (mounted) messenger.toast(LiveCopy.commandError(null));
    } finally {
      if (mounted) setState(() => _endBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(liveMediaProvider(_sessionId));
    final publication =
        ref.watch(liveMediaPublicationProvider).value ??
        const LiveMediaPublication();
    final screenSupported = ref.watch(screenCaptureSupportedProvider);
    final me = widget.session.me;

    return LiveDockBar(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _StatusStrip(
            state: state,
            publication: publication,
            screenSupported: screenSupported,
            hand: me.hand,
            presenting: _presenting,
            canJoin: me.canJoin,
          ),
          const SizedBox(height: Insets.sm),
          _dock(state, publication, me, screenSupported),
        ],
      ),
    );
  }

  Widget _dock(
    LiveMediaState state,
    LiveMediaPublication pub,
    LiveMe me,
    bool screenSupported,
  ) {
    final connected =
        state is LiveMediaConnected || state is LiveMediaReconnecting;
    final reconnecting = state is LiveMediaReconnecting;
    final hand = me.hand;
    final activeHand = hand != null &&
        (hand.state == SpeakerRequestState.pending ||
            hand.state == SpeakerRequestState.granted);

    final buttons = <Widget>[];

    // Media-primary slot: mic (connected) / join / rejoin / retry / locked.
    if (connected) {
      buttons.add(LiveDockButton(
        key: const Key('live-mic-toggle'),
        icon: pub.microphoneOn ? Icons.mic_rounded : Icons.mic_off_rounded,
        label: LiveCopy.dockMic,
        active: pub.microphoneOn,
        busy: _micBusy,
        onTap: reconnecting ? null : _toggleMic,
      ));
    } else if (state is LiveMediaIdle && me.canJoin) {
      buttons.add(LiveDockButton(
        key: const Key('live-audio-join'),
        icon: Icons.headset_mic_rounded,
        label: LiveCopy.dockJoin,
        active: true,
        onTap: _connect,
      ));
    } else if (state is LiveMediaDisconnected) {
      buttons.add(LiveDockButton(
        key: const Key('live-audio-rejoin'),
        icon: Icons.refresh_rounded,
        label: LiveCopy.audioRejoin,
        onTap: _connect,
      ));
    } else if (state is LiveMediaFailed) {
      buttons.add(LiveDockButton(
        key: const Key('live-audio-retry'),
        icon: Icons.refresh_rounded,
        label: LiveCopy.retry,
        onTap: _connect,
      ));
    } else {
      buttons.add(LiveDockButton(
        icon: Icons.mic_off_rounded,
        label: LiveCopy.dockMic,
        locked: true,
        busy: state is LiveMediaConnecting,
      ));
    }

    // Camera — never a source (locked, in its reference position).
    buttons.add(const LiveDockButton(
      icon: Icons.videocam_off_rounded,
      label: LiveCopy.dockCamera,
      locked: true,
    ));

    // Screen share — a presenter's real capture.
    if (connected && (_presenting || pub.screenShareOn)) {
      final canToggle = pub.screenShareOn ||
          (screenSupported && pub.screenAuthorized);
      buttons.add(LiveDockButton(
        key: const Key('live-screen-toggle'),
        icon: pub.screenShareOn
            ? Icons.stop_screen_share_rounded
            : Icons.screen_share_rounded,
        label: LiveCopy.dockScreen,
        active: pub.screenShareOn,
        busy: _screenBusy,
        onTap: (reconnecting || !canToggle) ? null : _toggleScreen,
      ));
    }

    // Reactions (ADR 0049): the dock's quick reaction is a heart; the strip
    // above the dock carries all four.
    if (liveCanReact(widget.session)) {
      buttons.add(LiveDockButton(
        key: const Key('live-dock-react'),
        icon: Icons.favorite_rounded,
        label: LiveCopy.dockReact,
        onTap: () => sendLiveReaction(
          context,
          ref,
          _sessionId,
          LiveReactionKind.heart,
        ),
      ));
    }

    // The viewer's own hand (independent of the audio connection).
    if (activeHand) {
      final granted = hand.state == SpeakerRequestState.granted;
      buttons.add(LiveDockButton(
        key: const Key('live-lower-hand'),
        icon: Icons.back_hand_rounded,
        label: granted ? LiveCopy.yieldFloor : LiveCopy.lowerHand,
        active: true,
        busy: _handBusy,
        onTap: () => _hand(true, granted),
      ));
    } else if (me.canRaiseHand) {
      buttons.add(LiveDockButton(
        key: const Key('live-raise-hand'),
        icon: Icons.front_hand_rounded,
        label: LiveCopy.raiseHand,
        busy: _handBusy,
        onTap: () => _hand(false, false),
      ));
    }

    if (connected) {
      buttons.add(LiveDockButton(
        key: const Key('live-audio-leave'),
        icon: Icons.logout_rounded,
        label: LiveCopy.dockLeave,
        onTap: _media.disconnect,
      ));
    }

    if (me.canEnd) {
      buttons.add(LiveDockButton(
        key: const Key('live-end-session'),
        icon: Icons.call_end_rounded,
        label: LiveCopy.endSession,
        danger: true,
        busy: _endBusy,
        onTap: _end,
      ));
    }

    // Center when the row fits the width; scroll horizontally when it would
    // overflow a narrow phone — never a RenderFlex overflow.
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: ConstrainedBox(
          constraints: BoxConstraints(minWidth: constraints.maxWidth),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (final button in buttons)
                SizedBox(width: 68, child: button),
            ],
          ),
        ),
      ),
    );
  }
}

/// The compact status line above the dock: where the connection stands, and
/// what the SDK has actually published (mic / screen) plus the viewer's own
/// hand — all the server-/SDK-reconciled truth, never a command's optimistic
/// result.
class _StatusStrip extends StatelessWidget {
  const _StatusStrip({
    required this.state,
    required this.publication,
    required this.screenSupported,
    required this.hand,
    required this.presenting,
    required this.canJoin,
  });

  final LiveMediaState state;
  final LiveMediaPublication publication;
  final bool screenSupported;
  final LiveMyHand? hand;
  final bool presenting;
  final bool canJoin;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final connected =
        state is LiveMediaConnected || state is LiveMediaReconnecting;

    final title = switch (state) {
      LiveMediaUnavailable() => LiveCopy.audioUnavailable,
      LiveMediaIdle() =>
        canJoin ? LiveCopy.audioIdlePrompt : LiveCopy.audioJoinUnavailable,
      LiveMediaConnecting() => LiveCopy.audioJoining,
      LiveMediaConnected() => LiveCopy.audioConnectedTitle,
      LiveMediaReconnecting() => LiveCopy.audioReconnecting,
      LiveMediaDisconnected(:final reason) => switch (reason) {
        LiveMediaDisconnectReason.duplicateIdentity => LiveCopy.audioEvicted,
        LiveMediaDisconnectReason.participantRemoved => LiveCopy.audioRemoved,
        _ => LiveCopy.audioDisconnected,
      },
      LiveMediaFailed() => LiveCopy.audioFailed,
    };

    final details = <String>[
      if (connected) publication.microphoneOn
          ? LiveCopy.micOnStatus
          : LiveCopy.micOffStatus,
      if (connected && (presenting || publication.screenShareOn))
        if (publication.screenShareOn)
          LiveCopy.screenShareOnStatus
        else if (!screenSupported)
          LiveCopy.screenShareUnsupported
        else if (!publication.screenAuthorized)
          LiveCopy.screenShareConfirming,
      if (hand != null && hand!.state == SpeakerRequestState.pending)
        LiveCopy.handStatusPending
      else if (hand != null && hand!.state == SpeakerRequestState.granted)
        LiveCopy.handStatusGranted,
    ];

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          title,
          textAlign: TextAlign.center,
          style: context.text.bodyMedium?.copyWith(color: colors.onSurface),
        ),
        if (state is LiveMediaUnavailable) ...[
          const SizedBox(height: Insets.xs),
          Text(
            LiveCopy.audioUnavailableMessage,
            textAlign: TextAlign.center,
            style: context.text.bodySmall,
          ),
        ],
        if (details.isNotEmpty) ...[
          const SizedBox(height: Insets.xs),
          Wrap(
            alignment: WrapAlignment.center,
            spacing: Insets.md,
            runSpacing: Insets.xs,
            children: [
              for (final detail in details)
                Text(
                  detail,
                  style: context.text.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
            ],
          ),
        ],
      ],
    );
  }
}
