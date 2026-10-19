import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/communities.dart';
import '../community_copy.dart';
import '../state/community_list_controller.dart';
import '../state/community_write.dart';
import 'community_change.dart';

/// Opens the create-community sheet. The caller shows the entry point only to a
/// holder of `communities.create` (OWNER/ADMIN); the server re-authorises the
/// create on the request, so a hidden button is a courtesy, never the control.
Future<void> showCreateCommunity(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => const _CreateCommunitySheet(),
  );
}

/// A title, then one create. The title's rules are the server's — this only
/// keeps the button from sending an empty one, and caps the field at 100
/// characters as the server does; the server validates and re-authorises, and
/// a refusal is said in words ([sayWriteOutcome]). One request, sent once: a
/// second tap while it is on its way sends nothing. On success the list is read
/// again (the new community heads it) and the sheet closes.
class _CreateCommunitySheet extends ConsumerStatefulWidget {
  const _CreateCommunitySheet();

  @override
  ConsumerState<_CreateCommunitySheet> createState() =>
      _CreateCommunitySheetState();
}

class _CreateCommunitySheetState extends ConsumerState<_CreateCommunitySheet> {
  final _field = TextEditingController();
  bool _submitting = false;
  CommunityKind _kind = CommunityKind.group;

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  bool get _canSubmit => !_submitting && _field.text.trim().isNotEmpty;

  Future<void> _submit() async {
    if (!_canSubmit) return;
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    setState(() => _submitting = true);
    final outcome = await ref
        .read(communityListProvider.notifier)
        .create(_field.text, kind: _kind);
    if (!mounted) return;
    if (outcome is WriteDone) {
      messenger.toast(CommunityCopy.communityCreated);
      if (navigator.canPop()) navigator.pop();
      return;
    }
    setState(() => _submitting = false);
    sayWriteOutcome(messenger, outcome, refresh: () {});
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return SafeArea(
      child: Padding(
        padding: EdgeInsetsDirectional.fromSTEB(
          Insets.lg,
          0,
          Insets.lg,
          Insets.lg + bottomInset,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              CommunityCopy.createCommunityTitle,
              style: context.text.titleMedium,
            ),
            const SizedBox(height: Insets.md),
            TextField(
              key: const Key('create-community-title'),
              controller: _field,
              autofocus: true,
              maxLength: 100,
              enabled: !_submitting,
              textInputAction: TextInputAction.done,
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _submit(),
              decoration: const InputDecoration(
                labelText: CommunityCopy.communityTitleLabel,
                hintText: CommunityCopy.communityTitleHint,
              ),
            ),
            const SizedBox(height: Insets.sm),
            Text(
              CommunityCopy.communityKindLabel,
              style: context.text.labelLarge,
            ),
            const SizedBox(height: Insets.xs),
            SegmentedButton<CommunityKind>(
              segments: const [
                ButtonSegment(
                  value: CommunityKind.group,
                  icon: Icon(Icons.groups_rounded),
                  label: Text(CommunityCopy.communityKindGroup),
                ),
                ButtonSegment(
                  value: CommunityKind.channel,
                  icon: Icon(Icons.campaign_rounded),
                  label: Text(CommunityCopy.communityKindChannel),
                ),
              ],
              selected: {_kind},
              onSelectionChanged: _submitting
                  ? null
                  : (selection) => setState(() => _kind = selection.first),
            ),
            const SizedBox(height: Insets.xs),
            Text(
              _kind == CommunityKind.channel
                  ? CommunityCopy.communityKindChannelHint
                  : CommunityCopy.communityKindGroupHint,
              style: context.text.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: Insets.md),
            FilledButton.icon(
              key: const Key('create-community-submit'),
              onPressed: _canSubmit ? _submit : null,
              icon: _submitting
                  ? const BusyIndicator()
                  : const Icon(Icons.add_rounded),
              label: const Text(CommunityCopy.createCommunityAction),
            ),
          ],
        ),
      ),
    );
  }
}
