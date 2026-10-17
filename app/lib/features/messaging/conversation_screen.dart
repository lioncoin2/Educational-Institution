import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../data/models/communities.dart';
import '../../data/models/messaging.dart';
import '../../providers/app_providers.dart';
import '../communities/state/community_controller.dart';
import 'messaging_copy.dart';
import '../../data/models/notifications.dart';
import 'state/conversation_controller.dart';
import 'state/conversation_list_controller.dart';
import 'state/conversation_mutes_controller.dart';
import 'state/direct_message_starter.dart';
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
    // Moderation authority is a COMMUNITY capability (ADR 0029), surfaced only
    // on the community's `me` — never on the conversation. For a community
    // chat, ask the community whether this viewer may moderate; the server
    // still re-checks every delete. Not a community chat → never offered.
    final communityId = conversation?.communityId;
    final canModerate = communityId == null
        ? false
        : ref.watch(
            communityProvider(communityId).select(
              (state) =>
                  state.value?.community?.me.has(
                    CommunityCapability.messagesModerate,
                  ) ??
                  false,
            ),
          );
    // Starting a direct conversation (Q6, owner GROUP A ruling): offered on a
    // co-member's name in a group or community chat, to a viewer whose account
    // may start one (a student → another student; staff → anyone). The server
    // decides who they may actually reach, so this only governs the affordance.
    final canStartDm = ref.watch(
      sessionUserProvider.select(
        (user) =>
            user.value?.can('messaging.start_direct_peer') == true ||
            user.value?.can('messaging.start_direct') == true,
      ),
    );
    // Per-conversation PUSH mute (Q6 / ADR 0036), the viewer's own choice.
    // Backend-only (the server stores it); the server re-checks every change.
    final backend = ref.watch(backendModeProvider);
    final muted =
        ref
            .watch(conversationMutesProvider)
            .value
            ?.contains(widget.conversationId) ??
        false;
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
          if (backend && conversation != null)
            IconButton(
              key: const Key('conversation-mute-toggle'),
              tooltip: muted ? MessagingCopy.unmute : MessagingCopy.mute,
              onPressed: () => _toggleMute(muted),
              icon: Icon(
                muted
                    ? Icons.notifications_off_outlined
                    : Icons.notifications_none_rounded,
              ),
            ),
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
              child: _Timeline(
                state: state,
                unreadAfter: _unreadAfter,
                canModerate: canModerate,
                canStartDm: canStartDm,
              ),
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

  /// Flips this conversation's PUSH mute through the controller (optimistic,
  /// reverts on failure), and says what changed. The server is the authority.
  Future<void> _toggleMute(bool muted) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref
          .read(conversationMutesProvider.notifier)
          .setMuted(widget.conversationId, !muted);
      messenger.toast(muted ? MessagingCopy.unmuted : MessagingCopy.muted);
    } on NotificationsException {
      messenger.toast(MessagingCopy.muteToggleFailed);
    }
  }
}

class _Timeline extends ConsumerWidget {
  const _Timeline({
    required this.state,
    required this.unreadAfter,
    this.canModerate = false,
    this.canStartDm = false,
  });

  final ConversationState state;
  final int? unreadAfter;

  /// The viewer may moderate this community chat (ADR 0029): a delete on any
  /// message, and a review of a deleted one. Always false outside a community
  /// chat, and for a member without the capability.
  final bool canModerate;

  /// The viewer's account may start a direct conversation (Q6): a student with
  /// another student, staff with anyone. Makes a co-member's name in a group or
  /// community chat tappable; the server still decides who they may reach.
  final bool canStartDm;

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
          // Tapping a co-member's name starts a direct conversation with them
          // (Q6), when the viewer's account may and the name is known. The
          // server decides who they may actually reach — the UI is not the gate.
          onTapAuthor:
              canStartDm &&
                  showNames &&
                  !state.isMine(message) &&
                  state.senderNames[message.senderId] != null
              ? () => _messageAuthor(
                  context,
                  ref,
                  message.senderId,
                  state.senderNames[message.senderId]!,
                )
              : null,
          // A moderator may delete a live message, or review a tombstoned one
          // (ADR 0029). The server re-authorizes every call regardless.
          onModerateDelete: canModerate && !message.isDeleted
              ? () =>
                    _moderateDelete(context, ref, state.conversation.id, message.id)
              : null,
          onReview: canModerate && message.isDeleted
              ? () => _review(context, ref, state.conversation.id, message.id)
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

/// Deletes a message as a moderator (ADR 0029): confirm first, then the
/// controller tombstones it on success. The server re-authorizes; a refusal is
/// said through its code, nothing local changes then.
Future<void> _moderateDelete(
  BuildContext context,
  WidgetRef ref,
  String conversationId,
  String messageId,
) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      scrollable: true,
      title: const Text(MessagingCopy.moderateDeleteTitle),
      content: const Text(MessagingCopy.moderateDeleteBody),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text(MessagingCopy.moderateCancel),
        ),
        TextButton(
          style: TextButton.styleFrom(foregroundColor: context.colors.error),
          onPressed: () => Navigator.pop(context, true),
          child: const Text(MessagingCopy.moderateDeleteConfirm),
        ),
      ],
    ),
  );
  if (confirmed != true || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  try {
    await ref
        .read(conversationProvider(conversationId).notifier)
        .moderateDelete(messageId);
    messenger.toast(MessagingCopy.moderateDeleteDone);
  } on MessagingException catch (error) {
    messenger.toast(MessagingCopy.error(error.code));
  }
}

/// Reveals a deleted message's original (ADR 0029 §21.3) in a dialog — its
/// content, who deleted it, and how many attachments it carried. Past the
/// 7-day window, or with no such deleted message, the server refuses and the
/// refusal is said through its code.
Future<void> _review(
  BuildContext context,
  WidgetRef ref,
  String conversationId,
  String messageId,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final ReviewedMessage reviewed;
  try {
    reviewed = await ref
        .read(conversationProvider(conversationId).notifier)
        .reviewMessage(messageId);
  } on MessagingException catch (error) {
    messenger.toast(MessagingCopy.error(error.code));
    return;
  }
  if (!context.mounted) return;
  final body = reviewed.body;
  await showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      scrollable: true,
      title: const Text(MessagingCopy.reviewTitle),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(body == null || body.isEmpty ? MessagingCopy.reviewNoText : body),
          if (reviewed.attachments.isNotEmpty) ...[
            const SizedBox(height: Insets.sm),
            Text(
              MessagingCopy.reviewAttachments(reviewed.attachments.length),
              style: context.text.labelSmall,
            ),
          ],
          const SizedBox(height: Insets.sm),
          Text(
            MessagingCopy.reviewDeletedBy(reviewed.deletedByName),
            style: context.text.labelSmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text(MessagingCopy.reviewClose),
        ),
      ],
    ),
  );
}

/// Offers to start a direct conversation with [userId] (Q6): a sheet naming the
/// person, then the start itself. The server decides who the viewer may reach —
/// a refusal (a counterpart they may not, reported like an unknown account) is
/// said through its code, and nothing opens. On success the conversation list
/// is refreshed and the conversation opened by its own id. The start is
/// idempotent, so even a stray second tap never makes a second conversation.
Future<void> _messageAuthor(
  BuildContext context,
  WidgetRef ref,
  String userId,
  String name,
) async {
  final chosen = await showModalBottomSheet<bool>(
    context: context,
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.all(Insets.lg),
            child: Text(
              MessagingCopy.messagePerson(name),
              style: context.text.titleMedium,
            ),
          ),
          ListTile(
            key: Key('start-dm-$userId'),
            leading: const Icon(Icons.chat_bubble_outline_rounded),
            title: const Text(MessagingCopy.startDm),
            onTap: () => Navigator.pop(sheet, true),
          ),
          const SizedBox(height: Insets.sm),
        ],
      ),
    ),
  );
  if (chosen != true || !context.mounted) return;
  final messenger = ScaffoldMessenger.of(context);
  final result = await ref.read(directMessageStarterProvider).start(userId);
  if (!context.mounted) return;
  switch (result) {
    case OpenConversation(:final location):
      // A newly started conversation should be in the list when the viewer
      // returns to it (offline, there is no realtime to announce it).
      ref.invalidate(conversationListProvider);
      context.push(location);
    case CannotStartDm(:final message):
      messenger.toast(message);
  }
}
