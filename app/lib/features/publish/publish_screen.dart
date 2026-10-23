import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/theme/messaging_palette.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/section_header.dart';
import '../../core/widgets/layout/app_screen.dart';
import '../../data/models/communities.dart';
import '../../data/models/messaging.dart';
import '../../data/models/publication.dart';
import '../../providers/app_providers.dart';
import 'publish_copy.dart';
import 'state/publish_controller.dart';

/// The communities the viewer may choose as targets. The server authorizes each
/// one again at publish time, so this list is only a convenience for choosing.
final _publishTargetsProvider = FutureProvider.autoDispose<List<Community>>((
  ref,
) async {
  final page = await ref.watch(communityRepositoryProvider).communities();
  return page.items;
});

/// Mass publishing: compose one notice / image / voice recording / document and
/// send it to several communities at once. The server authorizes each community
/// on its own and reports each outcome; the screen shows partial results and
/// offers a retry for what transiently failed. Nothing is hidden as a gate —
/// every publish re-authorizes server-side.
class PublishScreen extends ConsumerStatefulWidget {
  const PublishScreen({super.key});

  @override
  ConsumerState<PublishScreen> createState() => _PublishScreenState();
}

class _PublishScreenState extends ConsumerState<PublishScreen> {
  final _textController = TextEditingController();
  bool _recording = false;

  @override
  void dispose() {
    _textController.dispose();
    super.dispose();
  }

  PublishController get _controller =>
      ref.read(publishControllerProvider.notifier);

  Future<void> _pickImage() async {
    final picker = ref.read(attachmentPickerProvider);
    final file = await picker.pickImage();
    if (file != null) _controller.attach(file);
  }

  Future<void> _pickDocument() async {
    final picker = ref.read(attachmentPickerProvider);
    final file = await picker.pickDocument();
    if (file != null) _controller.attach(file);
  }

  Future<void> _toggleRecording() async {
    final recorder = ref.read(voiceRecorderProvider);
    if (_recording) {
      final voice = await recorder.stop();
      if (mounted) setState(() => _recording = false);
      if (voice != null) _controller.attach(voice.toOutgoingFile());
    } else {
      await recorder.start();
      if (mounted) setState(() => _recording = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final draft = ref.watch(publishControllerProvider);
    // Bulk publishing shares the messaging surface's institutional green (the
    // shared [InstitutionGreenPalette]), scoped here below the nav shell.
    final screen = AppScreen(
      title: PublishCopy.title,
      slivers: [
        SliverGutter(
          top: Insets.lg,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SectionHeader(title: PublishCopy.composeTitle),
              const SizedBox(height: Insets.md),
              _ComposeCard(
                textController: _textController,
                draft: draft,
                recording: _recording,
                onTextChanged: _controller.setText,
                onPickImage: _pickImage,
                onPickDocument: _pickDocument,
                onToggleRecording: _toggleRecording,
                onClearAttachment: _controller.clearAttachment,
              ),
              const SizedBox(height: Insets.lg),
              const SectionHeader(title: PublishCopy.targetsTitle),
              const SizedBox(height: Insets.md),
              _TargetsCard(
                selected: draft.targets,
                onToggle: _controller.toggleTarget,
              ),
              const SizedBox(height: Insets.lg),
              FilledButton(
                onPressed: draft.canPublish ? _controller.publish : null,
                child: draft.submission.isLoading
                    ? const SizedBox(
                        height: 18,
                        width: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text(PublishCopy.publish),
              ),
              const SizedBox(height: Insets.lg),
              _ResultsSection(draft: draft, onRetry: _controller.retryFailed),
            ],
          ),
        ),
      ],
    );
    return Theme(
      data: MessagingPalette.themeOf(context),
      child: screen,
    );
  }
}

class _ComposeCard extends ConsumerWidget {
  const _ComposeCard({
    required this.textController,
    required this.draft,
    required this.recording,
    required this.onTextChanged,
    required this.onPickImage,
    required this.onPickDocument,
    required this.onToggleRecording,
    required this.onClearAttachment,
  });

  final TextEditingController textController;
  final PublishDraft draft;
  final bool recording;
  final ValueChanged<String> onTextChanged;
  final VoidCallback onPickImage;
  final VoidCallback onPickDocument;
  final VoidCallback onToggleRecording;
  final VoidCallback onClearAttachment;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mediaReady = ref.watch(attachmentPickerProvider).isAvailable;
    final recorderReady = ref.watch(voiceRecorderProvider).isSupported;
    final attachment = draft.attachment;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: textController,
            onChanged: onTextChanged,
            minLines: 3,
            maxLines: 6,
            decoration: const InputDecoration(
              hintText: PublishCopy.textHint,
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: Insets.md),
          if (attachment != null)
            _AttachmentChip(attachment: attachment, onRemove: onClearAttachment)
          else if (!mediaReady && !recorderReady)
            Text(
              PublishCopy.mediaUnavailable,
              style: context.text.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            )
          else
            Wrap(
              spacing: Insets.sm,
              runSpacing: Insets.sm,
              children: [
                if (mediaReady)
                  OutlinedButton.icon(
                    key: const Key('publish-attach-image'),
                    onPressed: onPickImage,
                    icon: const Icon(Icons.image_outlined, size: 18),
                    label: const Text(PublishCopy.attachImage),
                  ),
                if (mediaReady)
                  OutlinedButton.icon(
                    key: const Key('publish-attach-document'),
                    onPressed: onPickDocument,
                    icon: const Icon(Icons.description_outlined, size: 18),
                    label: const Text(PublishCopy.attachDocument),
                  ),
                if (recorderReady)
                  OutlinedButton.icon(
                    key: const Key('publish-record-voice'),
                    onPressed: onToggleRecording,
                    icon: Icon(
                      recording ? Icons.stop : Icons.mic_none,
                      size: 18,
                    ),
                    label: Text(
                      recording
                          ? PublishCopy.stopRecording
                          : PublishCopy.recordVoice,
                    ),
                  ),
              ],
            ),
        ],
      ),
    );
  }
}

class _AttachmentChip extends StatelessWidget {
  const _AttachmentChip({required this.attachment, required this.onRemove});

  final OutgoingFile attachment;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(
          switch (attachment.kind) {
            AttachmentKind.image => Icons.image_outlined,
            AttachmentKind.voice => Icons.mic_none,
            AttachmentKind.audio => Icons.audiotrack_outlined,
            _ => Icons.description_outlined,
          },
          size: 18,
          color: context.colors.primary,
        ),
        const SizedBox(width: Insets.sm),
        Expanded(
          child: Text(attachment.fileName, overflow: TextOverflow.ellipsis),
        ),
        IconButton(
          tooltip: PublishCopy.removeAttachment,
          onPressed: onRemove,
          icon: const Icon(Icons.close, size: 18),
        ),
      ],
    );
  }
}

class _TargetsCard extends ConsumerWidget {
  const _TargetsCard({required this.selected, required this.onToggle});

  final Set<String> selected;
  final ValueChanged<String> onToggle;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(_publishTargetsProvider);
    return AppCard(
      padding: EdgeInsets.zero,
      child: AsyncView(
        value: value,
        loading: const Padding(
          padding: EdgeInsets.all(Insets.lg),
          child: Center(child: CircularProgressIndicator()),
        ),
        errorBuilder: (context, _) => const Padding(
          padding: EdgeInsets.all(Insets.lg),
          child: Text(PublishCopy.targetsError),
        ),
        builder: (context, communities) {
          if (communities.isEmpty) {
            return const Padding(
              padding: EdgeInsets.all(Insets.lg),
              child: Text(PublishCopy.targetsEmpty),
            );
          }
          return Column(
            children: [
              for (final (index, community) in communities.indexed) ...[
                if (index > 0) const Divider(height: 1),
                CheckboxListTile(
                  key: Key('publish-target-${community.id}'),
                  value: selected.contains(community.id),
                  onChanged: (_) => onToggle(community.id),
                  title: Text(community.title),
                  controlAffinity: ListTileControlAffinity.leading,
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _ResultsSection extends ConsumerWidget {
  const _ResultsSection({required this.draft, required this.onRetry});

  final PublishDraft draft;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final submission = draft.submission;
    if (submission.isLoading) return const SizedBox.shrink();
    if (submission.hasError) {
      final error = submission.error;
      final code = error is MessagingException ? error.code : null;
      return AppCard(
        child: Row(
          children: [
            Icon(Icons.error_outline, size: 18, color: context.colors.error),
            const SizedBox(width: Insets.sm),
            Expanded(child: Text(PublishCopy.error(code))),
          ],
        ),
      );
    }
    final report = submission.value;
    if (report == null) return const SizedBox.shrink();

    // Resolve a community title where the loaded list has it; fall back to id.
    final titles = <String, String>{
      for (final c
          in ref.watch(_publishTargetsProvider).value ?? const <Community>[])
        c.id: c.title,
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionHeader(title: PublishCopy.resultsTitle),
        const SizedBox(height: Insets.md),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(PublishCopy.summary(report), style: context.text.titleSmall),
              const SizedBox(height: Insets.md),
              for (final outcome in report.results) ...[
                _OutcomeRow(
                  title: titles[outcome.communityId] ?? outcome.communityId,
                  outcome: outcome,
                ),
                const SizedBox(height: Insets.sm),
              ],
              if (report.retryableCommunityIds.isNotEmpty) ...[
                const SizedBox(height: Insets.sm),
                Align(
                  alignment: AlignmentDirectional.centerEnd,
                  child: OutlinedButton(
                    key: const Key('publish-retry-failed'),
                    onPressed: onRetry,
                    child: const Text(PublishCopy.retryFailed),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _OutcomeRow extends StatelessWidget {
  const _OutcomeRow({required this.title, required this.outcome});

  final String title;
  final PublicationOutcome outcome;

  @override
  Widget build(BuildContext context) {
    final ok = outcome.status.isSuccess;
    final color = ok ? context.colors.primary : context.colors.error;
    return Row(
      children: [
        Icon(
          ok ? Icons.check_circle_outline : Icons.cancel_outlined,
          size: 18,
          color: color,
        ),
        const SizedBox(width: Insets.sm),
        Expanded(child: Text(title, overflow: TextOverflow.ellipsis)),
        const SizedBox(width: Insets.sm),
        Text(
          PublishCopy.status(outcome.status),
          style: context.text.bodySmall?.copyWith(
            color: context.colors.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}
