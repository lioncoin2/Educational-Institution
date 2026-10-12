import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/people.dart';
import '../community_copy.dart';
import '../state/community_members_controller.dart';
import '../state/community_write.dart';
import '../state/member_candidates_provider.dart';
import 'community_change.dart';

/// Opens the add-member picker for [communityId]. The caller shows it only when
/// the server's `me` grants `community.members.invite`; the server still
/// decides on every search and every add.
Future<void> showAddMember(BuildContext context, {required String communityId}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => _AddMemberSheet(communityId: communityId),
  );
}

/// A community-scoped candidate search (gated server-side on
/// `community.members.invite` in THIS community — never the institution-wide
/// directory) with an add on each result. Finding a person and adding them are
/// two separate server decisions: a result discloses only {userId, displayName},
/// and the add is re-authorised by the server. On a successful add the roster
/// reconciles (the controller) and the sheet closes.
class _AddMemberSheet extends ConsumerStatefulWidget {
  const _AddMemberSheet({required this.communityId});

  final String communityId;

  @override
  ConsumerState<_AddMemberSheet> createState() => _AddMemberSheetState();
}

class _AddMemberSheetState extends ConsumerState<_AddMemberSheet> {
  final _field = TextEditingController();
  Timer? _debounce;
  String _query = '';
  bool _submitting = false;

  @override
  void dispose() {
    _debounce?.cancel();
    _field.dispose();
    super.dispose();
  }

  void _onChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      if (mounted) setState(() => _query = value);
    });
  }

  Future<void> _add(PersonSearchResult person) async {
    if (_submitting) return;
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    final roster = ref.read(communityMembersProvider(widget.communityId).notifier);
    setState(() => _submitting = true);
    final outcome = await roster.addMembers([person.userId]);
    if (!mounted) return;
    if (outcome is WriteDone) {
      messenger.toast(CommunityCopy.memberAdded);
      if (navigator.canPop()) navigator.pop();
      return;
    }
    setState(() => _submitting = false);
    sayWriteOutcome(messenger, outcome, refresh: () {}, confirmed: true);
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
            Text(CommunityCopy.addMemberTitle, style: context.text.titleMedium),
            const SizedBox(height: Insets.md),
            TextField(
              key: const Key('add-member-search'),
              controller: _field,
              autofocus: true,
              onChanged: _onChanged,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                hintText: CommunityCopy.addMemberSearchHint,
                prefixIcon: const Icon(Icons.search_rounded),
              ),
            ),
            const SizedBox(height: Insets.md),
            // Bounded so the sheet never grows past the screen; the list
            // scrolls within it.
            ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.sizeOf(context).height * 0.4,
              ),
              child: _results(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _results() {
    if (_query.trim().isEmpty) {
      return _Hint(text: CommunityCopy.addMemberPrompt);
    }
    final value = ref.watch(
      communityMemberCandidatesProvider((
        communityId: widget.communityId,
        query: _query,
      )),
    );
    return value.when(
      loading: () => const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      ),
      error: (error, _) => _Hint(
        text: error is PeopleException && error.isForbidden
            ? CommunityCopy.addMemberSearchForbidden
            : CommunityCopy.addMemberSearchError,
      ),
      data: (page) {
        if (page.items.isEmpty) return _Hint(text: CommunityCopy.addMemberNoResults);
        return ListView.builder(
          shrinkWrap: true,
          itemCount: page.items.length,
          itemBuilder: (context, index) {
            final person = page.items[index];
            return ListTile(
              title: Text(person.displayName ?? CommunityCopy.personFallback),
              trailing: OutlinedButton(
                key: Key('add-member-${person.userId}'),
                onPressed: _submitting ? null : () => _add(person),
                child: const Text(CommunityCopy.addMemberAction),
              ),
            );
          },
        );
      },
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(Insets.lg),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: context.text.bodyMedium?.copyWith(color: context.colors.onSurfaceVariant),
      ),
    );
  }
}
