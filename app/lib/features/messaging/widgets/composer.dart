import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/messaging.dart';
import '../../../providers/app_providers.dart';

/// Where a message is written: text, an attachment, or a voice recording.
///
/// Attachments and recording go through capability seams. When this build
/// has no file picker or recorder, their buttons stay visible but disabled,
/// with a tooltip that says so — the person learns the feature exists and
/// why it is not here yet, instead of wondering where it went.
class Composer extends ConsumerStatefulWidget {
  const Composer({
    super.key,
    required this.onSendText,
    required this.onSendFile,
  });

  final void Function(String text) onSendText;
  final void Function(OutgoingFile file) onSendFile;

  /// The server's limit; the field stops accepting text here.
  static const int maxLength = 4000;

  @override
  ConsumerState<Composer> createState() => _ComposerState();
}

class _ComposerState extends ConsumerState<Composer> {
  final _controller = TextEditingController();
  bool _hasText = false;
  bool _recording = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      final hasText = _controller.text.trim().isNotEmpty;
      if (hasText != _hasText) setState(() => _hasText = hasText);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _send() {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    widget.onSendText(text);
    _controller.clear();
  }

  Future<void> _attach() async {
    final picker = ref.read(attachmentPickerProvider);
    final choice = await showModalBottomSheet<AttachmentKind>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.image_outlined),
              title: const Text('صورة'),
              onTap: () => Navigator.pop(context, AttachmentKind.image),
            ),
            ListTile(
              leading: const Icon(Icons.description_outlined),
              title: const Text('مستند PDF'),
              onTap: () => Navigator.pop(context, AttachmentKind.document),
            ),
          ],
        ),
      ),
    );
    if (choice == null) return;
    final file = choice == AttachmentKind.image
        ? await picker.pickImage()
        : await picker.pickDocument();
    if (file != null) widget.onSendFile(file);
  }

  Future<void> _toggleRecording() async {
    final recorder = ref.read(voiceRecorderProvider);
    if (!_recording) {
      try {
        await recorder.start();
        if (mounted) setState(() => _recording = true);
      } on Object {
        if (mounted) context.toast('تعذّر بدء التسجيل');
      }
      return;
    }
    final voice = await recorder.stop();
    if (!mounted) return;
    setState(() => _recording = false);
    if (voice != null) widget.onSendFile(voice.toOutgoingFile());
  }

  Future<void> _cancelRecording() async {
    await ref.read(voiceRecorderProvider).cancel();
    if (mounted) setState(() => _recording = false);
  }

  @override
  Widget build(BuildContext context) {
    final picker = ref.watch(attachmentPickerProvider);
    final recorder = ref.watch(voiceRecorderProvider);

    return Material(
      color: context.colors.surfaceContainerLow,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: Insets.sm,
            vertical: Insets.sm,
          ),
          child: _recording
              ? Row(
                  children: [
                    IconButton(
                      tooltip: 'إلغاء التسجيل',
                      onPressed: _cancelRecording,
                      icon: const Icon(Icons.delete_outline_rounded),
                    ),
                    const SizedBox(width: Insets.sm),
                    Icon(
                      Icons.fiber_manual_record_rounded,
                      color: context.colors.error,
                      size: 14,
                    ),
                    const SizedBox(width: Insets.xs),
                    const Expanded(child: Text('جارٍ التسجيل…')),
                    IconButton.filled(
                      tooltip: 'إيقاف وإرسال',
                      onPressed: _toggleRecording,
                      icon: const Icon(Icons.send_rounded),
                    ),
                  ],
                )
              : Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    IconButton(
                      tooltip: picker.isAvailable
                          ? 'إرفاق ملف'
                          : 'إرفاق الملفات غير متاح في هذا الإصدار',
                      onPressed: picker.isAvailable ? _attach : null,
                      icon: const Icon(Icons.attach_file_rounded),
                    ),
                    Expanded(
                      child: TextField(
                        controller: _controller,
                        minLines: 1,
                        maxLines: 5,
                        maxLength: Composer.maxLength,
                        textInputAction: TextInputAction.newline,
                        keyboardType: TextInputType.multiline,
                        decoration: const InputDecoration(
                          hintText: 'اكتب رسالة',
                          counterText: '',
                          isDense: true,
                          border: OutlineInputBorder(borderRadius: Radii.brXl),
                        ),
                      ),
                    ),
                    const SizedBox(width: Insets.xs),
                    if (_hasText)
                      IconButton.filled(
                        tooltip: 'إرسال',
                        onPressed: _send,
                        icon: const Icon(Icons.send_rounded),
                      )
                    else
                      IconButton(
                        tooltip: recorder.isSupported
                            ? 'تسجيل رسالة صوتية'
                            : 'التسجيل الصوتي غير متاح في هذا الإصدار',
                        onPressed: recorder.isSupported
                            ? _toggleRecording
                            : null,
                        icon: const Icon(Icons.mic_none_rounded),
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}
