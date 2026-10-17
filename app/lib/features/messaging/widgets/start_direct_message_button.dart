import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/extensions/context_ext.dart';
import '../state/conversation_list_controller.dart';
import '../state/direct_message_starter.dart';

/// Starts — or reopens — the direct conversation with [userId] and navigates to
/// it, reusing the one [DirectMessageStarter] (the single business-logic owner).
///
/// The id is passed in by the caller from a real server response; this widget
/// never infers or hardcodes one. The server re-authorises every start and is
/// idempotent per pair, so a repeated or double tap can make no second
/// conversation; a local busy flag additionally blocks overlapping in-flight
/// starts. A refusal (an account the viewer may not reach, a dropped network)
/// is shown in place via a toast and leaves nothing partial behind. The caller
/// decides whether to offer the affordance at all (capability gating) and
/// supplies the [label] and a stable [key].
class StartDirectMessageButton extends ConsumerStatefulWidget {
  const StartDirectMessageButton({
    super.key,
    required this.userId,
    required this.label,
  });

  final String userId;
  final String label;

  @override
  ConsumerState<StartDirectMessageButton> createState() =>
      _StartDirectMessageButtonState();
}

class _StartDirectMessageButtonState
    extends ConsumerState<StartDirectMessageButton> {
  bool _busy = false;

  Future<void> _start() async {
    if (_busy) return;
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    setState(() => _busy = true);
    final outcome = await ref
        .read(directMessageStarterProvider)
        .start(widget.userId);
    if (!mounted) return;
    setState(() => _busy = false);
    switch (outcome) {
      case OpenConversation(:final location):
        // The conversation should be in the list when the viewer returns.
        ref.invalidate(conversationListProvider);
        router.push(location);
      case CannotStartDm(:final message):
        messenger.toast(message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return TextButton.icon(
      onPressed: _busy ? null : _start,
      icon: _busy
          ? const SizedBox.square(
              dimension: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.forum_outlined, size: 18),
      label: Text(widget.label),
    );
  }
}
