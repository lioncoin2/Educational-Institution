import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/section_header.dart';
import '../../../data/models/live.dart';
import '../live_copy.dart';
import '../state/live_moderation_controller.dart';

/// The moderator's controls for a running session — end it, reset its room,
/// and the viewer's own presenter slot. Each control is shown ONLY when the
/// server's own `me` flag allows it ([LiveSessionMe.canEnd], `.canModerate`,
/// `.canPresent`, `.presenting`); nothing here decides who may act, and no
/// role name is read. A listener with no such flag sees nothing.
///
/// Every control goes through [LiveModerationController]; none touches the
/// session the screen shows. After a command the server emits its realtime
/// fact and the live session controller re-reads the authoritative session
/// (Slice 4) — so a success here changes no presenter list, count or state in
/// the app. Media (screen capture, audio) is a separate seam, unavailable in
/// this build and never implied by these authority controls.
class LiveModerationActions extends StatelessWidget {
  const LiveModerationActions({super.key, required this.session});

  final LiveSession session;

  @override
  Widget build(BuildContext context) {
    final me = session.me;
    final id = session.id;
    // Only the session's live state carries acting controls — an ended
    // session shows none (the screen renders the ended card instead).
    final controls = <Widget>[
      if (me.canPresent && !me.presenting)
        LiveCommandButton(
          key: const Key('live-claim-presenter'),
          label: LiveCopy.claimPresenter,
          icon: Icons.co_present_outlined,
          successMessage: LiveCopy.claimPresenterDone,
          action: (c) => c.claimPresenter(id),
        ),
      if (me.presenting)
        LiveCommandButton(
          key: const Key('live-stop-presenter'),
          label: LiveCopy.stopPresenter,
          icon: Icons.cancel_presentation_outlined,
          successMessage: LiveCopy.stopPresenterDone,
          action: (c) => c.stopPresenter(id),
        ),
      if (me.canModerate)
        LiveCommandButton(
          key: const Key('live-reset-room'),
          label: LiveCopy.resetRoom,
          icon: Icons.restart_alt_rounded,
          confirmQuestion: LiveCopy.resetRoomQuestion,
          confirmLabel: LiveCopy.resetRoomConfirm,
          successMessage: LiveCopy.resetRoomDone,
          action: (c) => c.resetRoom(id),
        ),
      if (me.canEnd)
        LiveCommandButton(
          key: const Key('live-end-session'),
          label: LiveCopy.endSession,
          icon: Icons.stop_circle_outlined,
          destructive: true,
          confirmQuestion: LiveCopy.endSessionQuestion,
          confirmLabel: LiveCopy.endSessionConfirm,
          successMessage: LiveCopy.endSessionDone,
          action: (c) => c.endSession(id),
        ),
    ];
    if (controls.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: Insets.xxl),
        const SectionHeader(title: LiveCopy.controlsSection),
        const SizedBox(height: Insets.md),
        for (final (i, control) in controls.indexed) ...[
          if (i > 0) const SizedBox(height: Insets.sm),
          control,
        ],
      ],
    );
  }
}

/// One moderator command as a button that owns its own in-flight state: while
/// its request is on its way it is disabled (so a second tap sends nothing)
/// and its icon becomes a spinner, the label kept so a screen reader still
/// names it. A destructive command is asked first. A refusal is said through
/// the server's code; a success says so — neither mutates the session, which
/// the realtime reconciliation keeps authoritative.
class LiveCommandButton extends ConsumerStatefulWidget {
  const LiveCommandButton({
    super.key,
    required this.label,
    required this.icon,
    required this.action,
    this.successMessage,
    this.confirmQuestion,
    this.confirmLabel,
    this.destructive = false,
  });

  final String label;
  final IconData icon;

  /// Runs the command on the controller. Its result is ignored on purpose —
  /// the authoritative session arrives through reconciliation, never from here.
  final Future<void> Function(LiveModerationController controller) action;

  final String? successMessage;

  /// When set, the person is asked this before the command is sent; dismissing
  /// is a no.
  final String? confirmQuestion;
  final String? confirmLabel;
  final bool destructive;

  @override
  ConsumerState<LiveCommandButton> createState() => _LiveCommandButtonState();
}

class _LiveCommandButtonState extends ConsumerState<LiveCommandButton> {
  bool _busy = false;

  Future<void> _press() async {
    if (_busy) return;
    final question = widget.confirmQuestion;
    if (question != null) {
      final yes = await confirmLiveAction(
        context,
        question: question,
        confirmLabel: widget.confirmLabel ?? widget.label,
        destructive: widget.destructive,
      );
      if (!yes || !mounted) return;
    }
    // Held before the await: the button may be gone when the answer comes.
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await widget.action(ref.read(liveModerationProvider));
      if (!mounted) return;
      final done = widget.successMessage;
      if (done != null) messenger.toast(done);
    } on LiveException catch (error) {
      messenger.toast(LiveCopy.commandError(error.code));
    } catch (_) {
      messenger.toast(LiveCopy.commandError(null));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.destructive ? context.colors.error : null;
    final icon = _busy
        ? const ExcludeSemantics(
            child: SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
          )
        : Icon(widget.icon);
    return OutlinedButton.icon(
      onPressed: _busy ? null : _press,
      icon: icon,
      label: Text(widget.label),
      style: color == null
          ? null
          : OutlinedButton.styleFrom(foregroundColor: color),
    );
  }
}

/// Asks before a moderator command — [question] names what, [confirmLabel]
/// the action. Only an explicit yes answers true; dismissing is a no. Scrolls
/// at a large text size so the answers stay in reach (the community pattern,
/// kept local to Live rather than shared into a generic framework).
Future<bool> confirmLiveAction(
  BuildContext context, {
  required String question,
  required String confirmLabel,
  bool destructive = false,
}) async {
  final yes = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      scrollable: true,
      title: Text(question),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text(LiveCopy.cancel),
        ),
        TextButton(
          style: destructive
              ? TextButton.styleFrom(foregroundColor: context.colors.error)
              : null,
          onPressed: () => Navigator.pop(context, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return yes ?? false;
}
