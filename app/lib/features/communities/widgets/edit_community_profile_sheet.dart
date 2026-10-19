import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_avatar.dart';
import '../../../data/models/communities.dart';
import '../../../data/models/files.dart';
import '../../../data/models/messaging.dart' show OutgoingFile;
import '../../../providers/app_providers.dart';
import '../community_copy.dart';
import '../state/community_controller.dart';
import '../state/community_write.dart';
import 'community_change.dart';

/// Opens the edit-community-profile sheet. The caller shows the entry only to a
/// holder of `community.profile.edit`; the server re-authorises on the request.
Future<void> showEditCommunityProfile(BuildContext context, Community community) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => _EditCommunityProfileSheet(community: community),
  );
}

/// Title, description and picture, then one save. The title and description
/// rules are the server's — this keeps the button from sending an empty title
/// and caps the fields as the server does; the server validates, verifies a new
/// picture is an image the editor owns, and re-authorises. A refusal is said in
/// words. One request, sent once. On success the community is read again and
/// the sheet closes.
class _EditCommunityProfileSheet extends ConsumerStatefulWidget {
  const _EditCommunityProfileSheet({required this.community});

  final Community community;

  @override
  ConsumerState<_EditCommunityProfileSheet> createState() =>
      _EditCommunityProfileSheetState();
}

class _EditCommunityProfileSheetState
    extends ConsumerState<_EditCommunityProfileSheet> {
  late final TextEditingController _title = TextEditingController(
    text: widget.community.title,
  );
  late final TextEditingController _description = TextEditingController(
    text: widget.community.description ?? '',
  );

  /// A newly picked picture waiting to be uploaded on save; null means leave
  /// the current one as it is (unless [_removePicture]).
  OutgoingFile? _picked;
  bool _removePicture = false;
  bool _submitting = false;

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  bool get _canSubmit => !_submitting && _title.text.trim().isNotEmpty;

  Future<void> _choosePicture() async {
    final picker = ref.read(attachmentPickerProvider);
    final messenger = ScaffoldMessenger.of(context);
    if (!picker.isAvailable) {
      messenger.toast(CommunityCopy.pickerUnavailable);
      return;
    }
    final image = await picker.pickImage();
    if (image == null || !mounted) return;
    setState(() {
      _picked = image;
      _removePicture = false;
    });
  }

  Future<void> _submit() async {
    if (!_canSubmit) return;
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    setState(() => _submitting = true);

    // Resolve the picture reference: a new upload, a clear, or the unchanged one.
    String? avatarFileAssetId;
    try {
      if (_picked != null) {
        avatarFileAssetId = await ref
            .read(filesRepositoryProvider)
            .uploadImage(_picked!);
      } else if (_removePicture) {
        avatarFileAssetId = null;
      } else {
        avatarFileAssetId = widget.community.avatarFileAssetId;
      }
    } on FilesException catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      messenger.toast(
        error.code == 'files.asset_kind_not_accepted'
            ? CommunityCopy.pictureInvalid
            : CommunityCopy.writeFailed(error.code),
      );
      return;
    }

    final outcome = await ref
        .read(communityProvider(widget.community.id).notifier)
        .updateProfile(
          title: _title.text,
          description: _description.text,
          avatarFileAssetId: avatarFileAssetId,
        );
    if (!mounted) return;
    if (outcome is WriteDone) {
      messenger.toast(CommunityCopy.communityUpdated);
      if (navigator.canPop()) navigator.pop();
      return;
    }
    setState(() => _submitting = false);
    sayWriteOutcome(messenger, outcome, refresh: () {});
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final currentUrl = ref.watch(
      communityAvatarUrlProvider(widget.community.id),
    );
    final showPicture = !_removePicture && _picked == null
        ? currentUrl.value
        : null;
    final hasPicture =
        _picked != null ||
        (!_removePicture && widget.community.avatarFileAssetId != null);

    return SafeArea(
      child: Padding(
        padding: EdgeInsetsDirectional.fromSTEB(
          Insets.lg,
          0,
          Insets.lg,
          Insets.lg + bottomInset,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                CommunityCopy.editCommunityTitle,
                style: context.text.titleMedium,
              ),
              const SizedBox(height: Insets.md),
              Row(
                children: [
                  AppAvatar(
                    name: _title.text.isEmpty
                        ? widget.community.title
                        : _title.text,
                    imageUrl: _picked == null ? showPicture : null,
                    radius: 28,
                  ),
                  const SizedBox(width: Insets.md),
                  Expanded(
                    child: Wrap(
                      spacing: Insets.sm,
                      children: [
                        TextButton.icon(
                          onPressed: _submitting ? null : _choosePicture,
                          icon: const Icon(Icons.photo_camera_outlined),
                          label: const Text(CommunityCopy.changePicture),
                        ),
                        if (hasPicture)
                          TextButton.icon(
                            onPressed: _submitting
                                ? null
                                : () => setState(() {
                                    _picked = null;
                                    _removePicture = true;
                                  }),
                            icon: const Icon(Icons.delete_outline),
                            label: const Text(CommunityCopy.removePicture),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: Insets.md),
              TextField(
                key: const Key('edit-community-title'),
                controller: _title,
                maxLength: 100,
                enabled: !_submitting,
                textInputAction: TextInputAction.next,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  labelText: CommunityCopy.communityTitleLabel,
                  hintText: CommunityCopy.communityTitleHint,
                ),
              ),
              const SizedBox(height: Insets.sm),
              TextField(
                key: const Key('edit-community-description'),
                controller: _description,
                maxLength: 500,
                maxLines: 3,
                enabled: !_submitting,
                decoration: const InputDecoration(
                  labelText: CommunityCopy.communityDescriptionLabel,
                  hintText: CommunityCopy.communityDescriptionHint,
                ),
              ),
              const SizedBox(height: Insets.sm),
              FilledButton.icon(
                key: const Key('edit-community-submit'),
                onPressed: _canSubmit ? _submit : null,
                icon: _submitting
                    ? const BusyIndicator()
                    : const Icon(Icons.save_outlined),
                label: const Text(CommunityCopy.editCommunityAction),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
