import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/messaging.dart';
import '../../../providers/app_providers.dart';
import '../messaging_copy.dart';
import '../state/conversation_controller.dart';

/// A confirmed message. The reader's own messages sit at the END side —
/// left in this right-to-left app, as Arabic chat apps place them — with no
/// manual mirroring: directional alignment does it.
class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.message,
    required this.mine,
    this.senderName,
  });

  final Message message;
  final bool mine;

  /// Shown above others' messages in groups and channels.
  final String? senderName;

  @override
  Widget build(BuildContext context) {
    return _BubbleFrame(
      mine: mine,
      header: senderName,
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
}

/// A message the server has not confirmed: sending, or failed with a retry.
class PendingBubble extends StatelessWidget {
  const PendingBubble({
    super.key,
    required this.pending,
    required this.onRetry,
    required this.onDiscard,
  });

  final PendingMessage pending;
  final VoidCallback onRetry;
  final VoidCallback onDiscard;

  @override
  Widget build(BuildContext context) {
    final failed = pending.status == DeliveryStatus.failed;
    final file = pending.file;
    return _BubbleFrame(
      mine: true,
      faded: !failed,
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
    this.faded = false,
  });

  final bool mine;
  final Widget child;
  final Widget footer;
  final String? header;
  final bool faded;

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
          if (header != null) ...[
            Text(
              header!,
              style: context.text.labelMedium?.copyWith(
                color: context.colors.primary,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 2),
          ],
          DefaultTextStyle.merge(style: context.text.bodyMedium, child: child),
          const SizedBox(height: Insets.xs),
          Align(alignment: AlignmentDirectional.centerEnd, child: footer),
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Align(
        alignment: mine
            ? AlignmentDirectional.centerEnd
            : AlignmentDirectional.centerStart,
        child: Opacity(opacity: faded ? 0.7 : 1, child: bubble),
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
