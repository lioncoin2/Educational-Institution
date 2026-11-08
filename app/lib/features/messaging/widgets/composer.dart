import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/media/media_seams.dart';
import '../../../data/models/messaging.dart';
import '../../../providers/app_providers.dart';
import '../messaging_copy.dart';
import '../state/conversation_controller.dart' show ReplyDraft;
import 'hold_to_record.dart';
import 'voice_wave.dart';

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
    this.onTyping,
    this.replyDraft,
    this.onCancelReply,
  });

  final void Function(String text) onSendText;
  final void Function(OutgoingFile file) onSendFile;

  /// Called as the viewer types, on each change that leaves text in the field.
  /// The receiver throttles it; the composer only reports activity.
  final VoidCallback? onTyping;

  /// The reply being composed, or null. When set, a quote banner sits above the
  /// input; [onCancelReply] dismisses it.
  final ReplyDraft? replyDraft;
  final VoidCallback? onCancelReply;

  /// The server's limit; the field stops accepting text here.
  static const int maxLength = 4000;

  @override
  ConsumerState<Composer> createState() => _ComposerState();
}

class _ComposerState extends ConsumerState<Composer> {
  final _controller = TextEditingController();
  bool _hasText = false;
  bool _recording = false;

  /// While holding to record, whether the finger has slid into the cancel zone
  /// — the UI turns to "release to cancel" and a release then discards.
  bool _cancelArmed = false;

  /// The recorder a hold started, until the hold ends. If the composer goes
  /// away mid-hold (a navigation), the gesture never reports its end, so
  /// [dispose] discards the recording rather than leave the microphone open.
  VoiceRecorder? _holdRecorder;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      final hasText = _controller.text.trim().isNotEmpty;
      if (hasText != _hasText) setState(() => _hasText = hasText);
      if (hasText) widget.onTyping?.call();
    });
  }

  @override
  void dispose() {
    final recorder = _holdRecorder;
    if (recorder != null) unawaited(recorder.cancel());
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

  /// The hold began: start recording. Optimistically flips the UI; on a start
  /// failure it reverts and says so. If the recorder was already rolling (a
  /// stray double-start) it is left as-is.
  Future<void> _beginRecording() async {
    if (_recording) return;
    setState(() {
      _recording = true;
      _cancelArmed = false;
    });
    final recorder = ref.read(voiceRecorderProvider);
    _holdRecorder = recorder;
    try {
      await recorder.start();
    } on Object {
      _holdRecorder = null;
      if (mounted) {
        setState(() => _recording = false);
        context.toast('تعذّر بدء التسجيل');
      }
    }
  }

  /// The hold ended: discard when cancelled (slid into the cancel zone, or the
  /// gesture was interrupted), otherwise stop and send.
  Future<void> _finishRecording({required bool cancelled}) async {
    if (!_recording) return;
    final recorder = ref.read(voiceRecorderProvider);
    _holdRecorder = null;
    if (cancelled) {
      await recorder.cancel();
      if (mounted) setState(() => _recording = false);
      return;
    }
    final voice = await recorder.stop();
    if (!mounted) return;
    setState(() => _recording = false);
    if (voice != null) widget.onSendFile(voice.toOutgoingFile());
  }

  @override
  Widget build(BuildContext context) {
    final picker = ref.watch(attachmentPickerProvider);
    final recorder = ref.watch(voiceRecorderProvider);

    return Material(
      color: context.colors.surfaceContainerLow,
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (widget.replyDraft case final draft?)
              _ReplyBanner(draft: draft, onCancel: widget.onCancelReply),
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: Insets.sm,
                vertical: Insets.sm,
              ),
              // One Row in both states, so the trailing control (the hold-to-
              // record target) stays MOUNTED through the whole press — the
              // gesture would die if its detector were rebuilt away. Only the
              // leading + middle swap between the text field and the recording
              // strip (ADR 0057).
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  if (!_recording)
                    IconButton(
                      tooltip: picker.isAvailable
                          ? 'إرفاق ملف'
                          : 'إرفاق الملفات غير متاح في هذا الإصدار',
                      onPressed: picker.isAvailable ? _attach : null,
                      icon: const Icon(Icons.attach_file_rounded),
                    ),
                  Expanded(
                    child: _recording
                        ? _RecordingStrip(
                            levels: recorder.amplitudes,
                            cancelArmed: _cancelArmed,
                          )
                        : TextField(
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
                              border: OutlineInputBorder(
                                borderRadius: Radii.brXl,
                              ),
                            ),
                          ),
                  ),
                  const SizedBox(width: Insets.xs),
                  if (_hasText && !_recording)
                    IconButton.filled(
                      tooltip: 'إرسال',
                      onPressed: _send,
                      icon: const Icon(Icons.send_rounded),
                    )
                  else
                    HoldToRecord(
                      enabled: recorder.isSupported,
                      onStart: _beginRecording,
                      onCancelArmedChanged: (armed) {
                        if (mounted) setState(() => _cancelArmed = armed);
                      },
                      onEnd: ({required cancelled}) =>
                          _finishRecording(cancelled: cancelled),
                      onQuickTap: () => context.toast(
                        recorder.isSupported
                            ? 'اضغط مطوّلًا للتسجيل، وأفلت للإرسال'
                            : 'التسجيل الصوتي غير متاح في هذا الإصدار',
                      ),
                      child: _MicTarget(
                        recording: _recording,
                        cancelArmed: _cancelArmed,
                        enabled: recorder.isSupported,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The strip shown in place of the text field while recording: a live level
/// waveform and a hint that slides to cancel. Turns red when the cancel is
/// armed (the finger has slid far enough that releasing will discard).
class _RecordingStrip extends StatelessWidget {
  const _RecordingStrip({required this.levels, required this.cancelArmed});

  final Stream<double> levels;
  final bool cancelArmed;

  @override
  Widget build(BuildContext context) {
    final danger = context.colors.error;
    return Row(
      key: const Key('composer-recording-strip'),
      children: [
        Icon(Icons.fiber_manual_record_rounded, size: 12, color: danger),
        const SizedBox(width: Insets.xs),
        Expanded(child: VoiceWave(levels: levels)),
        const SizedBox(width: Insets.sm),
        Text(
          cancelArmed ? 'أفلت للإلغاء' : 'اسحب للإلغاء',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: context.text.labelSmall?.copyWith(
            color: cancelArmed ? danger : context.colors.onSurfaceVariant,
            fontWeight: cancelArmed ? FontWeight.w700 : FontWeight.w400,
          ),
        ),
      ],
    );
  }
}

/// The mic tap target held to record. A plain mic when idle; a filled accent
/// mic while recording; a red trash when the cancel is armed. Sized like an
/// IconButton so the row's height does not jump when recording starts.
class _MicTarget extends StatelessWidget {
  const _MicTarget({
    required this.recording,
    required this.cancelArmed,
    required this.enabled,
  });

  final bool recording;
  final bool cancelArmed;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final IconData icon;
    final Color color;
    if (!recording) {
      icon = Icons.mic_none_rounded;
      color = enabled
          ? context.colors.onSurfaceVariant
          : context.colors.onSurface.withValues(alpha: 0.38);
    } else if (cancelArmed) {
      icon = Icons.delete_rounded;
      color = context.colors.error;
    } else {
      icon = Icons.mic_rounded;
      color = context.colors.primary;
    }
    return Tooltip(
      // Manual trigger: the default long-press trigger would add its OWN
      // recognizer and steal the hold-to-record gesture from the wrapper.
      triggerMode: TooltipTriggerMode.manual,
      message: enabled
          ? 'اضغط مطوّلًا للتسجيل، وأفلت للإرسال'
          : 'التسجيل الصوتي غير متاح في هذا الإصدار',
      child: SizedBox(
        width: 48,
        height: 48,
        child: AnimatedScale(
          scale: recording && !cancelArmed ? 1.25 : 1,
          duration: const Duration(milliseconds: 150),
          child: Icon(icon, color: color),
        ),
      ),
    );
  }
}

/// The reply quote shown above the composer while replying: an accent bar, the
/// original sender's name (when known) and a one-line preview, with a cancel
/// button. Reads in RTL and truncates long Arabic text to one line.
class _ReplyBanner extends StatelessWidget {
  const _ReplyBanner({required this.draft, this.onCancel});

  final ReplyDraft draft;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final accent = context.colors.primary;
    return Container(
      key: const Key('composer-reply-banner'),
      padding: const EdgeInsetsDirectional.only(
        start: Insets.md,
        end: Insets.xs,
        top: Insets.xs,
        bottom: Insets.xs,
      ),
      child: Row(
        children: [
          Container(
            width: 3,
            height: 34,
            margin: const EdgeInsetsDirectional.only(end: Insets.sm),
            decoration: BoxDecoration(color: accent, borderRadius: Radii.pill),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  draft.senderName == null
                      ? MessagingCopy.replyingTitle
                      : MessagingCopy.replyingTo(draft.senderName!),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.labelSmall?.copyWith(
                    color: accent,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  draft.preview,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            key: const Key('composer-reply-cancel'),
            tooltip: MessagingCopy.cancelReply,
            visualDensity: VisualDensity.compact,
            onPressed: onCancel,
            icon: const Icon(Icons.close_rounded),
          ),
        ],
      ),
    );
  }
}
