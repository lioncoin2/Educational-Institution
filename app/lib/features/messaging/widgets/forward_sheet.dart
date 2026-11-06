import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/messaging.dart';
import '../messaging_copy.dart';

/// Asks which conversation to forward a message into (Phase 2). Returns the
/// chosen conversation's id, or null if the viewer dismissed the sheet.
Future<String?> showForwardSheet(
  BuildContext context, {
  required List<Conversation> conversations,
}) {
  return showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => _ForwardSheet(conversations: conversations),
  );
}

class _ForwardSheet extends StatelessWidget {
  const _ForwardSheet({required this.conversations});

  final List<Conversation> conversations;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              Insets.lg,
              Insets.xs,
              Insets.lg,
              Insets.sm,
            ),
            child: Text(
              MessagingCopy.forwardTitle,
              style: context.text.titleMedium,
            ),
          ),
          if (conversations.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                Insets.lg,
                Insets.sm,
                Insets.lg,
                Insets.lg,
              ),
              child: Text(
                MessagingCopy.forwardNoTargets,
                style: context.text.bodyMedium?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            )
          else
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: conversations.length,
                itemBuilder: (context, index) {
                  final conversation = conversations[index];
                  return ListTile(
                    key: Key('forward-target-${conversation.id}'),
                    leading: Icon(
                      conversation.type == ConversationType.direct
                          ? Icons.person_outline
                          : Icons.forum_outlined,
                    ),
                    title: Text(
                      conversation.title ??
                          MessagingCopy.conversationFallbackTitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    onTap: () => Navigator.pop(context, conversation.id),
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}
