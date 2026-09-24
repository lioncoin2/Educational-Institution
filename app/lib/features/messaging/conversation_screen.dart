import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../data/models/messaging.dart';
import 'messaging_copy.dart';
import 'state/conversation_controller.dart';
import 'widgets/composer.dart';
import 'widgets/connection_banner.dart';
import 'widgets/message_bubble.dart';

/// One conversation: its timeline, newest at the bottom, and the composer.
class ConversationScreen extends ConsumerStatefulWidget {
  const ConversationScreen({super.key, required this.conversationId});

  final String conversationId;

  @override
  ConsumerState<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends ConsumerState<ConversationScreen> {
  /// The watermark when the screen opened: messages after it get a
  /// "new messages" divider, which stays put while the watermark moves.
  int? _unreadAfter;

  @override
  Widget build(BuildContext context) {
    final provider = conversationProvider(widget.conversationId);
    final value = ref.watch(provider);

    // Whatever is on screen counts as read — once it is on screen. The
    // provider is auto-disposed, so every opening goes loading → data and
    // this fires for it.
    ref.listen(provider, (previous, next) {
      final state = next.value;
      if (state == null) return;
      _unreadAfter ??= state.lastReadSequence;
      if (state.newestSequence > state.lastReadSequence) {
        ref.read(provider.notifier).markLatestRead();
      }
    });

    final conversation = value.value?.conversation;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              conversation?.title ?? 'محادثة',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (conversation != null)
              Text(
                MessagingCopy.typeLabel(
                  conversation.type,
                  conversation.memberCount,
                ),
                style: context.text.labelSmall,
              ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'تحديث',
            onPressed: () => ref.read(provider.notifier).refreshNewer(),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: AsyncView(
        value: value,
        onRetry: () => ref.invalidate(provider),
        builder: (context, state) => Column(
          children: [
            const ConnectionBanner(),
            Expanded(
              child: _Timeline(state: state, unreadAfter: _unreadAfter),
            ),
            if (state.removed)
              const _Notice(
                icon: Icons.person_off_outlined,
                text: 'لم تعد عضوًا في هذه المحادثة.',
              )
            else if (state.conversation.canPost)
              Composer(
                onSendText: (text) =>
                    ref.read(provider.notifier).sendText(text),
                onSendFile: (file) =>
                    ref.read(provider.notifier).sendFile(file),
              )
            // A community chat closed to the viewer may be locked, or not
            // theirs to post in, or too large to post in now — the server
            // does not say which, so neither does the screen.
            else if (state.conversation.isCommunityChat)
              const _Notice(
                icon: Icons.lock_outline_rounded,
                text: MessagingCopy.cannotPostHere,
              )
            else
              const _Notice(
                icon: Icons.campaign_outlined,
                text: 'هذه قناة إعلانات: يمكنك القراءة فقط.',
              ),
          ],
        ),
      ),
    );
  }
}

class _Timeline extends ConsumerWidget {
  const _Timeline({required this.state, required this.unreadAfter});

  final ConversationState state;
  final int? unreadAfter;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifier = ref.read(
      conversationProvider(state.conversation.id).notifier,
    );
    if (state.messages.isEmpty && state.pending.isEmpty) {
      return Center(
        child: Text(
          'لا توجد رسائل بعد. ابدأ المحادثة.',
          style: context.text.bodyMedium,
        ),
      );
    }

    final showNames = state.conversation.type != ConversationType.direct;
    final firstUnread = state.messages
        .where(
          (m) =>
              unreadAfter != null &&
              m.sequence > unreadAfter! &&
              !state.isMine(m),
        )
        .firstOrNull;
    // Newest first, because the list is reversed: it opens at the bottom and
    // stays anchored there as messages arrive.
    final entries = <Widget>[
      for (final pending in state.pending.reversed)
        PendingBubble(
          key: ValueKey('pending-${pending.clientMessageId}'),
          pending: pending,
          onRetry: () => notifier.retry(pending.clientMessageId),
          onDiscard: () => notifier.discard(pending.clientMessageId),
        ),
      for (final message in state.messages.reversed) ...[
        MessageBubble(
          key: ValueKey(message.id),
          message: message,
          mine: state.isMine(message),
          senderName: showNames && !state.isMine(message)
              ? state.senderNames[message.senderId]
              : null,
        ),
        if (message == firstUnread) const _UnreadDivider(),
      ],
    ];

    return ListView.builder(
      reverse: true,
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.md,
        vertical: Insets.sm,
      ),
      itemCount: entries.length + 1,
      itemBuilder: (context, index) {
        if (index < entries.length) return entries[index];
        return _OlderMessages(state: state);
      },
    );
  }
}

/// The top of the timeline: loads older messages as it scrolls into view.
class _OlderMessages extends ConsumerStatefulWidget {
  const _OlderMessages({required this.state});

  final ConversationState state;

  @override
  ConsumerState<_OlderMessages> createState() => _OlderMessagesState();
}

class _OlderMessagesState extends ConsumerState<_OlderMessages> {
  @override
  void initState() {
    super.initState();
    if (widget.state.hasOlder && !widget.state.olderFailed) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          ref
              .read(conversationProvider(widget.state.conversation.id).notifier)
              .loadOlder();
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    if (!state.hasOlder) {
      return Padding(
        padding: const EdgeInsets.all(Insets.lg),
        child: Center(
          child: Text('بداية المحادثة', style: context.text.labelSmall),
        ),
      );
    }
    if (state.loadingOlder) {
      return const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return Center(
      child: TextButton(
        onPressed: () => ref
            .read(conversationProvider(state.conversation.id).notifier)
            .loadOlder(),
        child: Text(
          state.olderFailed
              ? 'تعذّر التحميل — إعادة المحاولة'
              : 'عرض الرسائل الأقدم',
        ),
      ),
    );
  }
}

class _UnreadDivider extends StatelessWidget {
  const _UnreadDivider();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.sm),
      child: Row(
        children: [
          Expanded(child: Divider(color: context.colors.primary)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Insets.sm),
            child: Text(
              'رسائل جديدة',
              style: context.text.labelSmall?.copyWith(
                color: context.colors.primary,
              ),
            ),
          ),
          Expanded(child: Divider(color: context.colors.primary)),
        ],
      ),
    );
  }
}

/// Where the composer would be, when there is nothing to compose.
class _Notice extends StatelessWidget {
  const _Notice({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: context.colors.surfaceContainerLow,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(Insets.lg),
          child: Row(
            children: [
              Icon(icon, color: context.colors.onSurfaceVariant),
              const SizedBox(width: Insets.sm),
              Expanded(child: Text(text, style: context.text.bodySmall)),
            ],
          ),
        ),
      ),
    );
  }
}
