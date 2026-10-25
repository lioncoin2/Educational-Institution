import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/live.dart';
import '../../../data/models/live_chat.dart';
import '../live_copy.dart';
import '../state/live_chat_controller.dart';

/// A live session's own chat (ADR 0047): the messages, the composer, and —
/// for a moderator, as the server's page says — the switch that closes it to
/// participants. Whether the viewer may post is the server's answer on every
/// post; the composer only mirrors the page's `canPost`.
class LiveChatPanel extends ConsumerStatefulWidget {
  const LiveChatPanel({super.key, required this.session, this.onOpenGroup});

  final LiveSession session;

  /// Opens the community's own group conversation — a different place.
  final VoidCallback? onOpenGroup;

  @override
  ConsumerState<LiveChatPanel> createState() => _LiveChatPanelState();
}

class _LiveChatPanelState extends ConsumerState<LiveChatPanel> {
  final _field = TextEditingController();
  bool _sending = false;

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final body = _field.text.trim();
    if (body.isEmpty || _sending) return;
    setState(() => _sending = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(liveChatProvider(widget.session.id).notifier).send(body);
      _field.clear();
    } on LiveException catch (error) {
      messenger.toast(LiveCopy.error(error.code));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _toggleLock(bool locked) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref
          .read(liveChatProvider(widget.session.id).notifier)
          .setLocked(locked);
      messenger.toast(
        locked ? LiveCopy.chatLockedDone : LiveCopy.chatUnlockedDone,
      );
    } on LiveException catch (error) {
      messenger.toast(LiveCopy.error(error.code));
    }
  }

  @override
  Widget build(BuildContext context) {
    final value = ref.watch(liveChatProvider(widget.session.id));
    return Column(
      key: const Key('live-chat-panel'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(LiveCopy.chatTitle, style: context.text.titleMedium),
            ),
            if (value.value?.canModerate ?? false)
              TextButton.icon(
                key: const Key('live-chat-lock'),
                onPressed: () => _toggleLock(!value.value!.locked),
                icon: Icon(
                  value.value!.locked
                      ? Icons.lock_open_rounded
                      : Icons.lock_outline_rounded,
                  size: 18,
                ),
                label: Text(
                  value.value!.locked ? LiveCopy.chatUnlock : LiveCopy.chatLock,
                ),
              ),
          ],
        ),
        Text(LiveCopy.chatHint, style: context.text.bodySmall),
        const SizedBox(height: Insets.sm),
        Expanded(
          child: value.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (_, _) => Center(
              child: Text(
                LiveCopy.chatLoadFailed,
                style: context.text.bodySmall,
              ),
            ),
            data: (chat) => _Messages(sessionId: widget.session.id, chat: chat),
          ),
        ),
        if (value.value case final chat?) ...[
          if (!widget.session.isLive || !chat.canPost && !chat.locked)
            _Notice(text: LiveCopy.chatEnded)
          else if (chat.locked)
            _Notice(
              key: const Key('live-chat-locked'),
              text: chat.canModerate
                  ? LiveCopy.chatLockedForModerator
                  : LiveCopy.chatLockedForMe,
            ),
          if (chat.canPost)
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const Key('live-chat-field'),
                    controller: _field,
                    minLines: 1,
                    maxLines: 3,
                    maxLength: 500,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _send(),
                    decoration: const InputDecoration(
                      hintText: LiveCopy.chatFieldHint,
                      counterText: '',
                    ),
                  ),
                ),
                IconButton(
                  key: const Key('live-chat-send'),
                  tooltip: LiveCopy.chatSend,
                  onPressed: _sending ? null : _send,
                  icon: const Icon(Icons.send_rounded),
                ),
              ],
            ),
        ],
        if (widget.onOpenGroup != null)
          TextButton.icon(
            key: const Key('live-chat-open'),
            onPressed: widget.onOpenGroup,
            icon: const Icon(Icons.forum_outlined, size: 18),
            label: const Text(LiveCopy.chatGroupOpen),
          ),
      ],
    );
  }
}

class _Messages extends ConsumerWidget {
  const _Messages({required this.sessionId, required this.chat});

  final String sessionId;
  final LiveChatState chat;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (chat.messages.isEmpty) {
      return Center(
        child: Text(
          LiveCopy.chatEmpty,
          textAlign: TextAlign.center,
          style: context.text.bodySmall,
        ),
      );
    }
    final newestFirst = chat.messages.reversed.toList(growable: false);
    return ListView.builder(
      reverse: true,
      itemCount: newestFirst.length + (chat.olderCursor == null ? 0 : 1),
      itemBuilder: (context, index) {
        if (index == newestFirst.length) {
          return TextButton(
            onPressed: () =>
                ref.read(liveChatProvider(sessionId).notifier).loadOlder(),
            child: const Text(LiveCopy.chatLoadOlder),
          );
        }
        return _MessageTile(message: newestFirst[index]);
      },
    );
  }
}

class _MessageTile extends StatelessWidget {
  const _MessageTile({required this.message});

  final LiveChatMessage message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      key: ValueKey('live-chat-${message.id}'),
      padding: const EdgeInsets.symmetric(vertical: Insets.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (message.senderDisplayName.isNotEmpty)
            Text(
              message.senderDisplayName,
              style: context.text.labelMedium?.copyWith(
                color: context.colors.primary,
                fontWeight: FontWeight.w700,
              ),
            ),
          Text(message.body, style: context.text.bodyMedium),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.sm),
      child: Row(
        children: [
          Icon(
            Icons.info_outline_rounded,
            size: 16,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(width: Insets.xs),
          Expanded(child: Text(text, style: context.text.bodySmall)),
        ],
      ),
    );
  }
}
