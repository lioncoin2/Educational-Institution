import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/section_header.dart';
import '../../../data/models/live.dart';
import '../../../data/models/live_media.dart';
import '../live_copy.dart';
import '../state/live_media_controller.dart';

/// The viewer's own place in a live session's audio: joining the media room,
/// the microphone, and — for a presenter — the screen-share capture. This is
/// media TRANSPORT only.
///
/// It watches ONE session's [LiveMediaController] through [liveMediaProvider]
/// (keyed on the session id, so a different session is a different machine and
/// can never show or drive this one's media) and dispatches the person's
/// intents to it. It reads no authority and fabricates no state: who may join
/// or present is the session's `me` — the server's answer — and the media
/// connection is never attendance, a permission, or a second source of session
/// truth.
///
/// Two product rules are enforced here:
///  - Joining is EXPLICIT — a button, never an automatic connect on build; and
///  - joining is not speaking — the microphone stays closed until the person
///    turns it on.
///
/// When no media provider is bound (the default build) the controller reports
/// [LiveMediaUnavailable] and this says so plainly, exactly as before.
class LiveMediaPanel extends ConsumerStatefulWidget {
  const LiveMediaPanel({super.key, required this.session});

  final LiveSession session;

  @override
  ConsumerState<LiveMediaPanel> createState() => _LiveMediaPanelState();
}

class _LiveMediaPanelState extends ConsumerState<LiveMediaPanel> {
  String get _sessionId => widget.session.id;
  bool get _presenting => widget.session.me.presenting;

  @override
  void didUpdateWidget(LiveMediaPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The presenter slot is the server's authority (granted or revoked through
    // moderation, reconciled into the session by its controller). When this
    // viewer LOSES the slot on the SAME session, the capture must stop too:
    // the backend already drops the track server-side, and the client releases
    // its own capture rather than keep producing media it no longer holds the
    // authority for. Best-effort — losing the slot is not an error to surface,
    // and if nothing was being captured the command is a harmless no-op.
    if (oldWidget.session.id == _sessionId &&
        oldWidget.session.me.presenting &&
        !_presenting) {
      final controller = ref.read(liveMediaProvider(_sessionId).notifier);
      unawaited(controller.setScreenShareEnabled(false).catchError((_) {}));
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(liveMediaProvider(_sessionId));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: Insets.xxl),
        const SectionHeader(title: LiveCopy.audioSection),
        const SizedBox(height: Insets.md),
        _body(state),
      ],
    );
  }

  Widget _body(LiveMediaState state) => switch (state) {
    // No provider bound — audio is unavailable in this build (unchanged copy).
    LiveMediaUnavailable() => const _StatusCard(
      icon: Icons.volume_off_rounded,
      title: LiveCopy.audioUnavailable,
      message: LiveCopy.audioUnavailableMessage,
    ),
    // Available, not joined. Joining is the server's answer (`me.canJoin`) and
    // is explicit; it never opens the microphone.
    LiveMediaIdle() =>
      widget.session.me.canJoin
          ? _StatusCard(
              icon: Icons.graphic_eq_rounded,
              title: LiveCopy.audioIdlePrompt,
              action: _ConnectButton(
                key: const Key('live-audio-join'),
                label: LiveCopy.audioJoin,
                icon: Icons.headset_mic_rounded,
                filled: true,
                sessionId: _sessionId,
              ),
            )
          : const _StatusCard(
              icon: Icons.volume_off_rounded,
              title: LiveCopy.audioJoinUnavailable,
            ),
    LiveMediaConnecting() => const _StatusCard(
      spinner: true,
      icon: Icons.graphic_eq_rounded,
      title: LiveCopy.audioJoining,
    ),
    // Connected and reconnecting share one card so the microphone/screen-share
    // state survives a transient reconnect (same widget, preserved State);
    // during a reconnect the controls are shown but disabled.
    LiveMediaConnected() => _ConnectedCard(
      sessionId: _sessionId,
      presenting: _presenting,
      reconnecting: false,
    ),
    LiveMediaReconnecting() => _ConnectedCard(
      sessionId: _sessionId,
      presenting: _presenting,
      reconnecting: true,
    ),
    LiveMediaDisconnected(:final reason) => _StatusCard(
      icon: Icons.volume_off_rounded,
      title: _disconnectMessage(reason),
      action: _ConnectButton(
        key: const Key('live-audio-rejoin'),
        label: LiveCopy.audioRejoin,
        icon: Icons.refresh_rounded,
        filled: false,
        sessionId: _sessionId,
      ),
    ),
    LiveMediaFailed() => _StatusCard(
      icon: Icons.error_outline_rounded,
      title: LiveCopy.audioFailed,
      action: _ConnectButton(
        key: const Key('live-audio-retry'),
        label: LiveCopy.retry,
        icon: Icons.refresh_rounded,
        filled: false,
        sessionId: _sessionId,
      ),
    ),
  };

  static String _disconnectMessage(LiveMediaDisconnectReason reason) =>
      switch (reason) {
        LiveMediaDisconnectReason.duplicateIdentity => LiveCopy.audioEvicted,
        LiveMediaDisconnectReason.participantRemoved => LiveCopy.audioRemoved,
        LiveMediaDisconnectReason.roomDeleted => LiveCopy.audioDisconnected,
        LiveMediaDisconnectReason.other => LiveCopy.audioDisconnected,
      };
}

/// A small card for a non-interactive (or single-action) media state: an icon
/// or a spinner, a line or two of Arabic, and an optional action below.
class _StatusCard extends StatelessWidget {
  const _StatusCard({
    required this.icon,
    required this.title,
    this.message,
    this.action,
    this.spinner = false,
  });

  final IconData icon;
  final bool spinner;
  final String title;
  final String? message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (spinner)
                const ExcludeSemantics(
                  child: SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              else
                Icon(icon, size: 18, color: context.colors.onSurfaceVariant),
              const SizedBox(width: Insets.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: context.text.bodyMedium),
                    if (message != null) ...[
                      const SizedBox(height: Insets.xs),
                      Text(
                        message!,
                        style: context.text.bodySmall?.copyWith(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
          if (action != null) ...[const SizedBox(height: Insets.md), action!],
        ],
      ),
    );
  }
}

/// Joins (or re-joins) the session audio — the only path that reaches `/join`,
/// and always explicit. It owns its in-flight state so a rebuild, a repeated
/// tap or a navigation cannot start a second join (the controller also
/// single-flights `/join`); connected/connecting/failed is then the
/// controller's to report through [liveMediaProvider], never fabricated here. A
/// join REFUSAL is server authority, said through its code; a media-connect
/// failure shows as the panel's failed state.
class _ConnectButton extends ConsumerStatefulWidget {
  const _ConnectButton({
    super.key,
    required this.label,
    required this.icon,
    required this.filled,
    required this.sessionId,
  });

  final String label;
  final IconData icon;
  final bool filled;

  /// The session whose media to connect.
  final String sessionId;

  @override
  ConsumerState<_ConnectButton> createState() => _ConnectButtonState();
}

class _ConnectButtonState extends ConsumerState<_ConnectButton> {
  bool _busy = false;

  Future<void> _press() async {
    if (_busy) return;
    final sessionId = widget.sessionId;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await ref.read(liveMediaProvider(sessionId).notifier).connect();
    } on LiveException catch (error) {
      // A `/join` refusal (not live, no longer permitted, …): the server's
      // code, in words — never a token or raw detail.
      if (mounted) messenger.toast(LiveCopy.commandError(error.code));
    } catch (_) {
      if (mounted) messenger.toast(LiveCopy.commandError(null));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final icon = _busy
        ? const ExcludeSemantics(
            child: SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          )
        : Icon(widget.icon);
    final onPressed = _busy ? null : _press;
    // Content-sized and start-aligned by the surrounding start-column (never
    // the full-width Align that would swallow the tap target).
    return widget.filled
        ? FilledButton.icon(
            onPressed: onPressed,
            icon: icon,
            label: Text(widget.label),
          )
        : OutlinedButton.icon(
            onPressed: onPressed,
            icon: icon,
            label: Text(widget.label),
          );
  }
}

/// The connected (or reconnecting) controls: the microphone, the screen-share
/// capture when this viewer presents, and leaving. Its State holds the LAST
/// microphone/screen state the SDK confirmed — reset to off each fresh
/// connection because this widget is rebuilt only across connected↔reconnecting
/// (the one transient the SDK recovers), and replaced on any true drop.
class _ConnectedCard extends ConsumerStatefulWidget {
  const _ConnectedCard({
    required this.sessionId,
    required this.presenting,
    required this.reconnecting,
  });

  final String sessionId;
  final bool presenting;
  final bool reconnecting;

  @override
  ConsumerState<_ConnectedCard> createState() => _ConnectedCardState();
}

class _ConnectedCardState extends ConsumerState<_ConnectedCard> {
  // Only the COMMAND-in-flight state is the widget's. The mic/screen "on" state
  // and the screen authorization are the SDK-reconciled publication's — read
  // from [liveMediaPublicationProvider], never held or guessed here.
  bool _micBusy = false;
  bool _screenBusy = false;

  LiveMediaController get _controller =>
      ref.read(liveMediaProvider(widget.sessionId).notifier);

  LiveMediaPublication get _publication =>
      ref.read(liveMediaPublicationProvider).value ??
      const LiveMediaPublication();

  Future<void> _toggleMic() async {
    if (_micBusy) return;
    final messenger = ScaffoldMessenger.of(context);
    final next = !_publication.microphoneOn;
    setState(() => _micBusy = true);
    try {
      await _controller.setMicrophoneEnabled(next);
      // The displayed on/off is the SDK publication's, reconciled from the
      // track events — never this command's optimistic result.
    } catch (_) {
      // A denied permission or an unsupported environment lands here; the seam
      // sanitizes the cause, so one actionable, recoverable line covers it, and
      // the toggle stays as the SDK reports (never a pretended success).
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
      await _controller.setScreenShareEnabled(next);
      // "On" is the SDK's published-track state, reconciled from track events —
      // never this command's result, and never a merely-granted slot.
    } catch (_) {
      // A cancelled picker, an unsupported browser or a grant the backend did
      // not permit all land here; the seam cannot tell them apart, so one
      // recoverable line covers all, and nothing is implied to be sharing.
      if (mounted) messenger.toast(LiveCopy.screenShareError);
    } finally {
      if (mounted) setState(() => _screenBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final enabled = !widget.reconnecting;
    // The reconciled truth: what the SDK says is actually published, and the
    // server's current screen authorization. The mic/screen toggles reflect
    // THIS, not a command result.
    final publication =
        ref.watch(liveMediaPublicationProvider).value ??
        const LiveMediaPublication();
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (widget.reconnecting)
                const ExcludeSemantics(
                  child: SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              else
                Icon(
                  Icons.graphic_eq_rounded,
                  size: 20,
                  color: context.colors.primary,
                ),
              const SizedBox(width: Insets.sm),
              Expanded(
                child: Text(
                  widget.reconnecting
                      ? LiveCopy.audioReconnecting
                      : LiveCopy.audioConnectedTitle,
                  style: context.text.titleMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: Insets.xs),
          Text(
            LiveCopy.audioConnectedHint,
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: Insets.md),
          _MediaToggle(
            key: const Key('live-mic-toggle'),
            on: publication.microphoneOn,
            busy: _micBusy,
            enabled: enabled,
            onToggle: _toggleMic,
            enableLabel: LiveCopy.micEnable,
            disableLabel: LiveCopy.micDisable,
            iconOn: Icons.mic_rounded,
            iconOff: Icons.mic_off_rounded,
            statusOn: LiveCopy.micOnStatus,
            statusOff: LiveCopy.micOffStatus,
          ),
          // The screen-share capture is shown to a current presenter (the
          // session's authority affordance) and whenever a track is still
          // publishing. But STARTING is enabled only once the server's LIVE
          // authorization is confirmed (`screenAuthorized`), never on
          // `me.presenting` alone — so the event-ordering window shows a
          // disabled "confirming…" control instead of a tap that would be
          // refused. Stopping is always allowed. The authority itself is
          // claimed/stopped through the moderation controls, never here.
          if (widget.presenting || publication.screenShareOn) ...[
            const SizedBox(height: Insets.md),
            _MediaToggle(
              key: const Key('live-screen-toggle'),
              on: publication.screenShareOn,
              busy: _screenBusy,
              enabled: enabled,
              canStart: publication.screenAuthorized,
              pendingHint: LiveCopy.screenShareConfirming,
              onToggle: _toggleScreen,
              enableLabel: LiveCopy.screenShareStart,
              disableLabel: LiveCopy.screenShareStop,
              iconOn: Icons.stop_screen_share_rounded,
              iconOff: Icons.screen_share_rounded,
              statusOn: LiveCopy.screenShareOnStatus,
            ),
          ],
          const SizedBox(height: Insets.lg),
          // Leaving is always available — even mid-reconnect.
          OutlinedButton.icon(
            key: const Key('live-audio-leave'),
            onPressed: _controller.disconnect,
            icon: const Icon(Icons.logout_rounded),
            label: const Text(LiveCopy.audioLeave),
          ),
        ],
      ),
    );
  }
}

/// One media track's on/off control: a status line (what the SDK last
/// confirmed) and a button whose label is the NEXT action. While a command is
/// on its way it shows a spinner and is disabled, so a second tap sends
/// nothing; it is also disabled while the connection is recovering.
class _MediaToggle extends StatelessWidget {
  const _MediaToggle({
    super.key,
    required this.on,
    required this.busy,
    required this.enabled,
    required this.onToggle,
    required this.enableLabel,
    required this.disableLabel,
    required this.iconOn,
    required this.iconOff,
    required this.statusOn,
    this.statusOff,
    this.canStart = true,
    this.pendingHint,
  });

  final bool on;
  final bool busy;
  final bool enabled;

  /// Whether the OFF→ON (start) action is permitted now — e.g. the server's
  /// live screen authorization is confirmed. Stopping is always permitted while
  /// connected; only starting waits on this.
  final bool canStart;

  /// Shown while off and [canStart] is false — the authorization is still being
  /// confirmed, so the control waits rather than offering a share that would be
  /// refused.
  final String? pendingHint;
  final Future<void> Function() onToggle;
  final String enableLabel;
  final String disableLabel;
  final IconData iconOn;
  final IconData iconOff;
  final String statusOn;
  final String? statusOff;

  @override
  Widget build(BuildContext context) {
    // Stopping (on→off) is always allowed while connected; starting (off→on)
    // additionally waits for [canStart] (the confirmed authorization).
    final actionEnabled = enabled && !busy && (on || canStart);
    final status = on
        ? statusOn
        : (canStart ? statusOff : (pendingHint ?? statusOff));
    final label = on ? disableLabel : enableLabel;
    final icon = busy
        ? const ExcludeSemantics(
            child: SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          )
        : Icon(on ? iconOn : iconOff);
    final onPressed = actionEnabled ? onToggle : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (status != null) ...[
          Text(
            status,
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: Insets.xs),
        ],
        if (on)
          FilledButton.tonalIcon(
            onPressed: onPressed,
            icon: icon,
            label: Text(label),
          )
        else
          OutlinedButton.icon(
            onPressed: onPressed,
            icon: icon,
            label: Text(label),
          ),
      ],
    );
  }
}
