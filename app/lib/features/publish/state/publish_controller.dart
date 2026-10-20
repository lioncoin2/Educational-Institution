import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/messaging.dart';
import '../../../data/models/publication.dart';
import '../../../providers/app_providers.dart';

/// What the composer holds: the chosen [targets], the [text] (a notice, or a
/// media caption), an optional [attachment], and the last [submission] result.
///
/// [batchId] and [uploadedAssetId] are the idempotency anchors: a publish mints
/// a batch id and (for media) uploads once; a RETRY of the same compose reuses
/// both, so the server re-posts nothing a community already received. Any edit
/// to the content starts a fresh compose (a new batch), so changed content is a
/// new publish, never silently folded into the previous one.
class PublishDraft {
  const PublishDraft({
    this.targets = const {},
    this.text = '',
    this.attachment,
    this.submission = const AsyncData<PublicationReport?>(null),
    this.batchId,
    this.uploadedAssetId,
  });

  final Set<String> targets;
  final String text;
  final OutgoingFile? attachment;
  final AsyncValue<PublicationReport?> submission;
  final String? batchId;
  final String? uploadedAssetId;

  /// The publish `kind` for this draft's content.
  String get kind => switch (attachment?.kind) {
    AttachmentKind.image => 'IMAGE',
    AttachmentKind.voice => 'VOICE',
    AttachmentKind.audio => 'FILE',
    AttachmentKind.document => 'FILE',
    _ => 'TEXT',
  };

  bool get hasContent => attachment != null || text.trim().isNotEmpty;

  bool get canPublish =>
      targets.isNotEmpty && hasContent && !submission.isLoading;

  PublicationReport? get report => submission.value;

  PublishDraft copyWith({
    Set<String>? targets,
    String? text,
    OutgoingFile? attachment,
    bool clearAttachment = false,
    AsyncValue<PublicationReport?>? submission,
    String? batchId,
    bool clearBatch = false,
    String? uploadedAssetId,
    bool clearUpload = false,
  }) => PublishDraft(
    targets: targets ?? this.targets,
    text: text ?? this.text,
    attachment: clearAttachment ? null : (attachment ?? this.attachment),
    submission: submission ?? this.submission,
    batchId: clearBatch ? null : (batchId ?? this.batchId),
    uploadedAssetId: clearUpload
        ? null
        : (uploadedAssetId ?? this.uploadedAssetId),
  );
}

/// Drives the mass-publish composer: holds the draft, uploads an attachment
/// once, publishes to the chosen communities, and retries only what transiently
/// failed — all through the repositories, which the server re-authorizes.
class PublishController extends Notifier<PublishDraft> {
  @override
  PublishDraft build() => const PublishDraft();

  /// Editing the content starts a fresh compose: the previous result and batch
  /// id are dropped so a changed message is a new publish, not a silent dedup.
  PublishDraft _editing() => state.copyWith(
    submission: const AsyncData<PublicationReport?>(null),
    clearBatch: true,
  );

  void setText(String text) => state = _editing().copyWith(text: text);

  void toggleTarget(String communityId) {
    final next = <String>{...state.targets};
    if (!next.remove(communityId)) next.add(communityId);
    state = _editing().copyWith(targets: next);
  }

  void attach(OutgoingFile file) =>
      state = _editing().copyWith(attachment: file, clearUpload: true);

  void clearAttachment() =>
      state = _editing().copyWith(clearAttachment: true, clearUpload: true);

  /// Publish the current draft to the chosen communities.
  Future<void> publish() async {
    if (!state.canPublish) return;
    final batchId =
        state.batchId ?? 'pub-${DateTime.now().microsecondsSinceEpoch}';
    await _send(batchId: batchId, communityIds: state.targets.toList());
  }

  /// Resend only the communities whose failure a plain retry can clear, reusing
  /// the same batch id and upload — the successes are not touched.
  Future<void> retryFailed() async {
    final report = state.report;
    if (report == null || state.batchId == null) return;
    final retryable = report.retryableCommunityIds;
    if (retryable.isEmpty) return;
    await _send(batchId: state.batchId!, communityIds: retryable);
  }

  Future<void> _send({
    required String batchId,
    required List<String> communityIds,
  }) async {
    state = state.copyWith(
      submission: const AsyncLoading<PublicationReport?>(),
      batchId: batchId,
    );
    try {
      String? assetId = state.uploadedAssetId;
      final attachment = state.attachment;
      if (attachment != null && assetId == null) {
        assetId = await ref.read(filesRepositoryProvider).upload(attachment);
      }
      final caption = state.text.trim();
      final report = await ref
          .read(messagingRepositoryProvider)
          .publishToCommunities(
            clientBatchId: batchId,
            communityIds: communityIds,
            kind: state.kind,
            body: caption.isEmpty ? null : caption,
            fileAssetId: assetId,
          );
      state = state.copyWith(
        submission: AsyncData(report),
        uploadedAssetId: assetId,
      );
    } catch (error, stack) {
      state = state.copyWith(submission: AsyncError(error, stack));
    }
  }
}

final publishControllerProvider =
    NotifierProvider.autoDispose<PublishController, PublishDraft>(
      PublishController.new,
    );
