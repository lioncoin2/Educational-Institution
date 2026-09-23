import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../data/models/messaging.dart';
import '../messaging_copy.dart';

/// One row of the conversation list: who, the latest message, unread count.
class ConversationTile extends StatelessWidget {
  const ConversationTile({
    super.key,
    required this.conversation,
    required this.onTap,
  });

  final Conversation conversation;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final unread = conversation.unreadCount > 0;
    final title = conversation.title ?? 'محادثة';
    final last = conversation.lastMessage;
    final preview = MessagingCopy.preview(last);
    final prefix =
        conversation.type != ConversationType.direct && last?.senderName != null
        ? '${last!.senderName}: '
        : '';

    return AppCard(
      onTap: onTap,
      padding: const EdgeInsets.all(Insets.md),
      color: unread
          ? context.colors.surfaceContainerLowest
          : context.colors.surfaceContainerLow,
      semanticLabel: unread
          ? '$title، ${conversation.unreadCount} رسائل غير مقروءة'
          : title,
      child: Row(
        children: [
          _Avatar(type: conversation.type, title: title),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.titleSmall?.copyWith(
                          fontWeight: unread
                              ? FontWeight.w700
                              : FontWeight.w500,
                        ),
                      ),
                    ),
                    const SizedBox(width: Insets.sm),
                    Text(
                      MessagingCopy.time(context, conversation.activityAt),
                      style: context.text.labelSmall,
                    ),
                  ],
                ),
                const SizedBox(height: Insets.xs),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        '$prefix$preview',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: context.text.bodySmall,
                      ),
                    ),
                    if (unread) ...[
                      const SizedBox(width: Insets.sm),
                      _UnreadBadge(count: conversation.unreadCount),
                    ],
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.type, required this.title});

  final ConversationType type;
  final String title;

  @override
  Widget build(BuildContext context) {
    final icon = switch (type) {
      ConversationType.group => Icons.groups_2_outlined,
      ConversationType.channel => Icons.campaign_outlined,
      _ => null,
    };
    final initial = title.isEmpty
        ? '؟'
        : String.fromCharCode(title.runes.first);
    return Container(
      width: 44,
      height: 44,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: context.colors.primaryContainer,
        shape: BoxShape.circle,
      ),
      child: icon == null
          ? Text(
              initial,
              style: context.text.titleMedium?.copyWith(
                color: context.colors.onPrimaryContainer,
              ),
            )
          : Icon(icon, size: 22, color: context.colors.onPrimaryContainer),
    );
  }
}

class _UnreadBadge extends StatelessWidget {
  const _UnreadBadge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 22),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: context.colors.primary,
        borderRadius: Radii.pill,
      ),
      child: Text(
        MessagingCopy.unreadBadge(count),
        textAlign: TextAlign.center,
        style: context.text.labelSmall?.copyWith(
          color: context.colors.onPrimary,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
