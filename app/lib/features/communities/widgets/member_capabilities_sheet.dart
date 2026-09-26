import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/communities.dart';
import '../community_copy.dart';
import '../state/community_controller.dart';
import '../state/community_write.dart';
import '../state/member_grants_controller.dart';
import 'community_change.dart';

/// Opens [member]'s capabilities in [communityId] over the roster.
Future<void> showMemberCapabilities(
  BuildContext context, {
  required String communityId,
  required CommunityMember member,
}) => showModalBottomSheet<void>(
  context: context,
  showDragHandle: true,
  isScrollControlled: true,
  builder: (context) =>
      MemberCapabilitiesSheet(communityId: communityId, member: member),
);

/// One member's capabilities, as the server lists their grants: each one
/// this version knows — granted, granted but not in effect now, or not
/// granted. Here the server's list is the source, so "granted" is what it
/// says; the community screen never says how a capability is held.
///
/// For a viewer whose `me.operations` holds community.grants.manage — and
/// only while it does: a grant is revoked one at a time, and those chosen
/// among the rest are granted in one request. One change at a time; the
/// list is read again after each, and a refusal is said here, without its
/// reason.
class MemberCapabilitiesSheet extends ConsumerStatefulWidget {
  const MemberCapabilitiesSheet({
    super.key,
    required this.communityId,
    required this.member,
  });

  final String communityId;
  final CommunityMember member;

  @override
  ConsumerState<MemberCapabilitiesSheet> createState() =>
      _MemberCapabilitiesSheetState();
}

class _MemberCapabilitiesSheetState
    extends ConsumerState<MemberCapabilitiesSheet> {
  final Set<CommunityCapability> _chosen = {};
  String? _failure;

  MemberKey get _member =>
      (communityId: widget.communityId, userId: widget.member.userId);

  MemberGrantsController get _grants =>
      ref.read(memberGrantsProvider(_member).notifier);

  Future<void> _grant() async {
    setState(() => _failure = null);
    final outcome = await _grants.grant({..._chosen});
    if (!mounted) return;
    setState(() {
      switch (outcome) {
        case WriteDone():
          _chosen.clear();
        case WriteFailed(:final error):
          _failure = CommunityCopy.writeFailed(error.code);
        case WriteNotSent():
          break;
      }
    });
  }

  Future<void> _revoke(CommunityGrant grant) async {
    setState(() => _failure = null);
    final outcome = await _grants.revoke(grant.grantId);
    if (!mounted) return;
    if (outcome case WriteFailed(:final error)) {
      setState(() => _failure = CommunityCopy.writeFailed(error.code));
    }
  }

  @override
  Widget build(BuildContext context) {
    final community = ref.watch(communityProvider(widget.communityId));
    final detail = community.value;
    final manages =
        detail != null &&
        !detail.removed &&
        (detail.community?.me.allows(CommunityOperation.grantsManage) ?? false);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.85,
        ),
        child: SingleChildScrollView(
          padding: EdgeInsets.symmetric(
            horizontal: context.gutter,
            vertical: Insets.sm,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                CommunityCopy.capabilitiesOf(widget.member),
                style: context.text.titleLarge,
              ),
              const SizedBox(height: Insets.md),
              if (detail == null)
                const _Waiting()
              else if (!manages)
                _Note(
                  detail.removed
                      ? CommunityCopy.removed
                      : CommunityCopy.notYours,
                )
              else
                ..._grantsOf(context),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _grantsOf(BuildContext context) {
    final value = ref.watch(memberGrantsProvider(_member));
    return value.when(
      loading: () => const [_Waiting()],
      error: (error, _) => [
        _Note(
          CommunityCopy.error(error is CommunityException ? error.code : null),
        ),
        Center(
          child: TextButton(
            onPressed: () => ref.invalidate(memberGrantsProvider(_member)),
            child: const Text(CommunityCopy.retry),
          ),
        ),
      ],
      data: (state) {
        if (state.forbidden) return const [_Note(CommunityCopy.notYours)];
        if (state.gone) return const [_Note(CommunityCopy.removed)];
        final writing = state.writing;
        final known = [
          for (final c in CommunityCapability.values)
            if (c != CommunityCapability.unknown) c,
        ];
        final grantable = known.where((c) => state.grantOf(c) == null);
        return [
          if (grantable.isNotEmpty) ...[
            Text(CommunityCopy.grantsHint, style: context.text.bodyMedium),
            const SizedBox(height: Insets.sm),
          ],
          for (final c in known)
            if (state.grantOf(c) case final grant?)
              _GrantedRow(
                capability: c,
                grant: grant,
                revoking:
                    writing is Revoking && writing.grantId == grant.grantId,
                onRevoke: writing == null ? () => _revoke(grant) : null,
              )
            else
              CheckboxListTile(
                value: _chosen.contains(c),
                controlAffinity: ListTileControlAffinity.leading,
                contentPadding: EdgeInsets.zero,
                title: Text(CommunityCopy.capability(c)),
                subtitle: const Text(CommunityCopy.notGranted),
                onChanged: writing == null
                    ? (on) => setState(
                        () => on ?? false ? _chosen.add(c) : _chosen.remove(c),
                      )
                    : null,
              ),
          if (_failure case final failure?) ...[
            const SizedBox(height: Insets.sm),
            Text(
              failure,
              style: context.text.bodySmall?.copyWith(
                color: context.colors.error,
              ),
            ),
          ],
          if (grantable.isNotEmpty) ...[
            const SizedBox(height: Insets.lg),
            FilledButton(
              onPressed: _chosen.isEmpty || writing != null ? null : _grant,
              child: writing is Granting
                  ? const BusyIndicator()
                  : const Text(CommunityCopy.grantChosen),
            ),
          ],
          const SizedBox(height: Insets.lg),
        ];
      },
    );
  }
}

/// A capability the server lists the member as holding, and its revoke.
class _GrantedRow extends StatelessWidget {
  const _GrantedRow({
    required this.capability,
    required this.grant,
    required this.revoking,
    required this.onRevoke,
  });

  final CommunityCapability capability;
  final CommunityGrant grant;
  final bool revoking;
  final VoidCallback? onRevoke;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        grant.dormant
            ? Icons.pause_circle_outline_rounded
            : Icons.check_circle_outline_rounded,
        color: context.colors.primary,
      ),
      title: Text(CommunityCopy.capability(capability)),
      subtitle: Text(CommunityCopy.grantStatus(grant)),
      trailing: Tooltip(
        message: CommunityCopy.revokeGrantTooltip(capability),
        child: TextButton(
          onPressed: revoking ? null : onRevoke,
          child: revoking
              ? const BusyIndicator()
              : const Text(CommunityCopy.revokeGrant),
        ),
      ),
    );
  }
}

class _Waiting extends StatelessWidget {
  const _Waiting();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.all(Insets.xxl),
      child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.lg),
      child: Text(message, style: context.text.bodyMedium),
    );
  }
}
