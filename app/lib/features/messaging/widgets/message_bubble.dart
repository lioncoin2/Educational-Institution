import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_avatar.dart';
import '../../../data/models/messaging.dart';
import '../../../providers/app_providers.dart';
import '../messaging_copy.dart';
import '../state/conversation_controller.dart';

/// A quoted message shown inside a reply's bubble: who it was from (when
/// known) and a one-line preview. Resolved from the real `replyToMessageId`
/// the server stores and returns; it carries no data the model does not.
class RepliedMessage {
  const RepliedMessage({this.senderName, required this.preview});

  /// The original sender's name, or null when it is the reader's own message
  /// or the name is not in the loaded window.
  final String? senderName;

  /// A short, already-truncated-at-source preview of the original.
  final String preview;
}

/// A confirmed message. The reader's own messages sit at the END side —
/// left in this right-to-left app, as Arabic chat apps place them — with no
/// manual mirroring: directional alignment does it.
class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.message,
    required this.mine,
    this.senderName,
    this.senderAvatarUrl,
    this.repliedTo,
    this.showHeader = true,
    this.groupedWithPrevious = false,
    this.onTapAuthor,
    this.onReply,
    this.onPin,
    this.onUnpin,
    this.onModerateDelete,
    this.onReview,
  });

  final Message message;
  final bool mine;

  /// Shown above others' messages in groups and channels — but only on the
  /// first message of a run from the same sender ([showHeader]).
  final String? senderName;

  /// The message this one is a reply to, when it is one and the original is
  /// known. Rendered as a quote inside the bubble.
  final RepliedMessage? repliedTo;

  /// Whether to draw the sender header (avatar + name). False for the later
  /// messages of a consecutive run, so a group reads as one block.
  final bool showHeader;

  /// Whether the previous message was from the same sender: the bubbles then
  /// sit closer together, the way a chat groups a run.
  final bool groupedWithPrevious;

  /// A short-lived link to the sender's picture, beside their name. Null shows
  /// their initials (no picture, or the demo).
  final Uri? senderAvatarUrl;

  /// Tapping the sender's name starts a direct conversation with them (Q6),
  /// when the viewer's account may start one. Null hides that affordance (a
  /// direct conversation, the viewer's own message, or a viewer who may not
  /// start one). The server still decides who the viewer may actually reach.
  final VoidCallback? onTapAuthor;

  /// Starts a reply to this message, or null when the viewer cannot post here.
  /// Offered on a long-press for any message that is not deleted.
  final VoidCallback? onReply;

  /// Pin this message (ADR 0043), or null when the viewer may not pin or it is
  /// already the pinned one. [onUnpin] clears the pin when this IS the pinned
  /// message. Both are moderator actions, offered on the long-press.
  final VoidCallback? onPin;
  final VoidCallback? onUnpin;

  /// A moderator's long-press actions (ADR 0029), or null when the viewer may
  /// not moderate. [onModerateDelete] deletes a live message; [onReview]
  /// reveals a tombstoned one's original. At most one applies to a message.
  final VoidCallback? onModerateDelete;
  final VoidCallback? onReview;

  @override
  Widget build(BuildContext context) {
    final canReply = onReply != null && !message.isDeleted;
    final hasActions =
        canReply ||
        onPin != null ||
        onUnpin != null ||
        onModerateDelete != null ||
        onReview != null;
    return _BubbleFrame(
      mine: mine,
      header: _header(context),
      groupedWithPrevious: groupedWithPrevious,
      reply: message.isDeleted || repliedTo == null
          ? null
          : _ReplyPreview(replied: repliedTo!, mine: mine),
      onLongPress: hasActions ? () => _showActionSheet(context) : null,
      footer: Text(
        MessagingCopy.clock(context, message.createdAt),
        style: context.text.labelSmall,
      ),
      child: message.isDeleted
          ? Text(
              'تم حذف هذه الرسالة',
              style: context.text.bodyMedium?.copyWith(
                fontStyle: FontStyle.italic,
              ),
            )
          : _MessageContent(message: message),
    );
  }

  /// The sender's name above others' messages (groups and channels). When the
  /// viewer may start a direct conversation, it is tappable and offers to start
  /// one with that person, with a small chat glyph to signal so; otherwise it
  /// is plain text. The server decides who the viewer may actually reach.
  Widget? _header(BuildContext context) {
    if (!showHeader) return null;
    final name = senderName;
    if (name == null) return null;
    final label = Text(
      name,
      style: context.text.labelMedium?.copyWith(
        color: context.colors.primary,
        fontWeight: FontWeight.w700,
      ),
    );
    final Widget named = onTapAuthor == null
        ? label
        : GestureDetector(
            key: Key('message-author-${message.senderId}'),
            behavior: HitTestBehavior.opaque,
            onTap: onTapAuthor,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Flexible(child: label),
                const SizedBox(width: Insets.xs),
                Icon(
                  Icons.chat_bubble_outline_rounded,
                  size: 14,
                  color: context.colors.primary,
                ),
              ],
            ),
          );
    // The sender's picture (or initials) sits before the name.
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        AppAvatar(name: name, imageUrl: senderAvatarUrl, radius: 12),
        const SizedBox(width: Insets.xs),
        Flexible(child: named),
      ],
    );
  }

  /// The long-press actions for this message: reply (for anyone who may post
  /// here), and the moderator's delete/review (ADR 0029) where held.
  void _showActionSheet(BuildContext context) {
    final canReply = onReply != null && !message.isDeleted;
    showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (canReply)
              ListTile(
                key: const Key('message-reply-action'),
                leading: const Icon(Icons.reply_rounded),
                title: const Text(MessagingCopy.reply),
                onTap: () {
                  Navigator.pop(sheetContext);
                  onReply!();
                },
              ),
            if (onPin != null)
              ListTile(
                key: const Key('message-pin-action'),
                leading: const Icon(Icons.push_pin_outlined),
                title: const Text(MessagingCopy.pin),
                onTap: () {
                  Navigator.pop(sheetContext);
                  onPin!();
                },
              ),
            if (onUnpin != null)
              ListTile(
                key: const Key('message-unpin-action'),
                leading: const Icon(Icons.push_pin_rounded),
                title: const Text(MessagingCopy.unpin),
                onTap: () {
                  Navigator.pop(sheetContext);
                  onUnpin!();
                },
              ),
            if (onReview != null)
              ListTile(
                leading: const Icon(Icons.history_rounded),
                title: const Text(MessagingCopy.reviewOriginal),
                onTap: () {
                  Navigator.pop(sheetContext);
                  onReview!();
                },
              ),
            if (onModerateDelete != null)
              ListTile(
                leading: Icon(
                  Icons.delete_outline_rounded,
                  color: context.colors.error,
                ),
                title: Text(
                  MessagingCopy.moderateDelete,
                  style: TextStyle(color: context.colors.error),
                ),
                onTap: () {
                  Navigator.pop(sheetContext);
                  onModerateDelete!();
                },
              ),
          ],
        ),
      ),
    );
  }
}

/// A message the server has not confirmed: sending, or failed with a retry.
class PendingBubble extends StatelessWidget {
  const PendingBubble({
    super.key,
    required this.pending,
    required this.onRetry,
    required this.onDiscard,
    this.repliedTo,
  });

  final PendingMessage pending;
  final VoidCallback onRetry;
  final VoidCallback onDiscard;

  /// The quote of the message this pending reply answers, so a sending or
  /// failed reply shows the same quote its confirmed self will.
  final RepliedMessage? repliedTo;

  @override
  Widget build(BuildContext context) {
    final failed = pending.status == DeliveryStatus.failed;
    final file = pending.file;
    return _BubbleFrame(
      mine: true,
      faded: !failed,
      reply: repliedTo == null
          ? null
          : _ReplyPreview(replied: repliedTo!, mine: true),
      footer: failed
          ? Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: Insets.xs,
              children: [
                Icon(
                  Icons.error_outline_rounded,
                  size: 16,
                  color: context.colors.error,
                ),
                Text(
                  MessagingCopy.error(pending.errorCode),
                  style: context.text.labelSmall?.copyWith(
                    color: context.colors.error,
                  ),
                ),
                TextButton(
                  onPressed: onRetry,
                  child: const Text('إعادة الإرسال'),
                ),
                TextButton(onPressed: onDiscard, child: const Text('حذف')),
              ],
            )
          : Semantics(
              label: 'جارٍ الإرسال',
              child: Icon(
                Icons.schedule_rounded,
                size: 14,
                color: context.colors.onSurfaceVariant,
              ),
            ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (file != null)
            _FileSummary(
              icon: _iconFor(pending.type),
              name: file.fileName,
              detail: pending.type == MessageType.voice
                  ? MessagingCopy.duration(file.durationMs)
                  : MessagingCopy.size(file.bytes.length),
            ),
          if (pending.body case final body? when body.isNotEmpty) Text(body),
        ],
      ),
    );
  }
}

class _BubbleFrame extends StatelessWidget {
  const _BubbleFrame({
    required this.mine,
    required this.child,
    required this.footer,
    this.header,
    this.reply,
    this.faded = false,
    this.groupedWithPrevious = false,
    this.onLongPress,
  });

  final bool mine;
  final Widget child;
  final Widget footer;
  final Widget? header;

  /// A quote of the message this one replies to, drawn above the content.
  final Widget? reply;
  final bool faded;

  /// Tightens the gap above the bubble when it continues a run from the same
  /// sender, so consecutive messages read as one block.
  final bool groupedWithPrevious;

  /// A long-press on the bubble (the moderator's actions), or null.
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final maxWidth = MediaQuery.sizeOf(context).width * 0.78;
    final bubble = Container(
      constraints: BoxConstraints(maxWidth: maxWidth.clamp(0, 520)),
      padding: const EdgeInsets.fromLTRB(
        Insets.md,
        Insets.sm,
        Insets.md,
        Insets.sm,
      ),
      decoration: BoxDecoration(
        color: mine
            ? context.colors.primaryContainer
            : context.colors.surfaceContainerHigh,
        borderRadius: BorderRadiusDirectional.only(
          topStart: Radii.lg,
          topEnd: Radii.lg,
          bottomStart: mine ? Radii.lg : Radii.sm,
          bottomEnd: mine ? Radii.sm : Radii.lg,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (header != null) ...[header!, const SizedBox(height: 2)],
          if (reply != null) ...[reply!, const SizedBox(height: Insets.xs)],
          DefaultTextStyle.merge(style: context.text.bodyMedium, child: child),
          const SizedBox(height: Insets.xs),
          Align(alignment: AlignmentDirectional.centerEnd, child: footer),
        ],
      ),
    );
    final pressable = onLongPress == null
        ? bubble
        : GestureDetector(
            behavior: HitTestBehavior.opaque,
            onLongPress: onLongPress,
            child: bubble,
          );
    return Padding(
      padding: EdgeInsets.only(top: groupedWithPrevious ? 1 : 6, bottom: 1),
      child: Align(
        alignment: mine
            ? AlignmentDirectional.centerEnd
            : AlignmentDirectional.centerStart,
        child: Opacity(opacity: faded ? 0.7 : 1, child: pressable),
      ),
    );
  }
}

/// A quoted reply inside a bubble: an accent bar, the original sender's name
/// (when known), and a one-line preview. Styled from tokens so it reads on
/// both the reader's and others' bubble colours.
class _ReplyPreview extends StatelessWidget {
  const _ReplyPreview({required this.replied, required this.mine});

  final RepliedMessage replied;
  final bool mine;

  @override
  Widget build(BuildContext context) {
    final accent = mine
        ? context.colors.onPrimaryContainer
        : context.colors.primary;
    return Container(
      key: const Key('message-reply-preview'),
      width: double.infinity,
      padding: const EdgeInsetsDirectional.fromSTEB(
        Insets.sm,
        Insets.xs,
        Insets.sm,
        Insets.xs,
      ),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.10),
        borderRadius: Radii.brSm,
        border: BorderDirectional(start: BorderSide(color: accent, width: 3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (replied.senderName case final name?)
            Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.text.labelSmall?.copyWith(
                color: accent,
                fontWeight: FontWeight.w700,
              ),
            ),
          Text(
            replied.preview,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: context.text.bodySmall?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

class _MessageContent extends StatelessWidget {
  const _MessageContent({required this.message});

  final Message message;

  @override
  Widget build(BuildContext context) {
    final attachment = message.attachments.firstOrNull;
    final caption = message.body;
    final media = switch (message.type) {
      MessageType.text => null,
      MessageType.image when attachment != null => ImageAttachment(
        message: message,
        attachment: attachment,
      ),
      MessageType.voice when attachment != null => VoiceAttachment(
        message: message,
        attachment: attachment,
      ),
      MessageType.file when attachment != null => _FileSummary(
        icon: Icons.description_outlined,
        name: attachment.displayName ?? 'ملف',
        detail: MessagingCopy.size(attachment.byteSize),
      ),
      _ => Text(
        'نوع رسالة لا يدعمه هذا الإصدار',
        style: context.text.bodySmall?.copyWith(fontStyle: FontStyle.italic),
      ),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        ?media,
        if (media != null && caption != null) const SizedBox(height: Insets.xs),
        if (caption != null) Text(caption),
      ],
    );
  }
}

/// An image, fetched through a short-lived link the server issues only to
/// members who can see this message.
class ImageAttachment extends ConsumerWidget {
  const ImageAttachment({
    super.key,
    required this.message,
    required this.attachment,
  });

  final Message message;
  final Attachment attachment;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final width = attachment.width;
    final height = attachment.height;
    final ratio = width != null && height != null && height > 0
        ? width / height
        : 4 / 3;
    return ClipRRect(
      borderRadius: Radii.brMd,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 260, maxHeight: 320),
        child: AspectRatio(
          aspectRatio: ratio.clamp(0.5, 2.0),
          child: !attachment.available
              ? const _MediaPlaceholder(
                  icon: Icons.image_not_supported_outlined,
                )
              : ref
                    .watch(
                      attachmentUrlProvider((
                        conversationId: message.conversationId,
                        messageId: message.id,
                        fileAssetId: attachment.fileAssetId,
                      )),
                    )
                    .when(
                      loading: () => const Center(
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                      error: (_, _) =>
                          const _MediaPlaceholder(icon: Icons.image_outlined),
                      data: (url) => Image.network(
                        url.toString(),
                        fit: BoxFit.cover,
                        semanticLabel: attachment.displayName ?? 'صورة',
                        errorBuilder: (_, _, _) => const _MediaPlaceholder(
                          icon: Icons.broken_image_outlined,
                        ),
                      ),
                    ),
        ),
      ),
    );
  }
}

/// A voice message: play (when this build can), and its length.
class VoiceAttachment extends ConsumerWidget {
  const VoiceAttachment({
    super.key,
    required this.message,
    required this.attachment,
  });

  final Message message;
  final Attachment attachment;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final player = ref.watch(voicePlayerProvider);
    final playable = player.isSupported && attachment.available;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton.filledTonal(
          tooltip: playable ? 'تشغيل' : 'التشغيل غير متاح في هذا الإصدار',
          onPressed: playable
              ? () async {
                  try {
                    final url = await ref
                        .read(messagingRepositoryProvider)
                        .attachmentUrl(
                          message.conversationId,
                          message.id,
                          attachment.fileAssetId,
                        );
                    await player.play(url);
                  } on MessagingException catch (error) {
                    if (context.mounted) {
                      context.toast(MessagingCopy.error(error.code));
                    }
                  }
                }
              : null,
          icon: const Icon(Icons.play_arrow_rounded),
        ),
        const SizedBox(width: Insets.sm),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('رسالة صوتية'),
            Text(
              MessagingCopy.duration(attachment.durationMs),
              style: context.text.labelSmall,
            ),
          ],
        ),
      ],
    );
  }
}

class _FileSummary extends StatelessWidget {
  const _FileSummary({
    required this.icon,
    required this.name,
    required this.detail,
  });

  final IconData icon;
  final String name;
  final String detail;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, color: context.colors.primary),
        const SizedBox(width: Insets.sm),
        Flexible(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(name, maxLines: 1, overflow: TextOverflow.ellipsis),
              if (detail.isNotEmpty)
                Text(detail, style: context.text.labelSmall),
            ],
          ),
        ),
      ],
    );
  }
}

class _MediaPlaceholder extends StatelessWidget {
  const _MediaPlaceholder({required this.icon});

  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: context.colors.surfaceContainer,
      child: Center(child: Icon(icon, color: context.colors.onSurfaceVariant)),
    );
  }
}

IconData _iconFor(MessageType type) => switch (type) {
  MessageType.voice => Icons.mic_none_rounded,
  MessageType.image => Icons.image_outlined,
  _ => Icons.description_outlined,
};
