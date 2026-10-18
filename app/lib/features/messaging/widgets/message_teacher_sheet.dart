import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/people.dart';
import '../messaging_copy.dart';
import '../state/conversation_list_controller.dart';
import '../state/direct_message_starter.dart';
import '../state/teacher_search_provider.dart';

/// Opens the "message a teacher" picker (Q6). The caller shows it only when the
/// viewer's account may start a teacher DM (`messaging.start_direct_teacher`);
/// the server still decides on every search and every start.
Future<void> showMessageTeacher(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => const _MessageTeacherSheet(),
  );
}

/// A name search over the teacher directory (gated server-side), with a tap on
/// a result to start — or reuse — a direct conversation with that teacher and
/// open it. Finding a teacher and messaging them are two server decisions: the
/// directory returns only eligible teachers, and the start is re-authorised.
class _MessageTeacherSheet extends ConsumerStatefulWidget {
  const _MessageTeacherSheet();

  @override
  ConsumerState<_MessageTeacherSheet> createState() => _MessageTeacherSheetState();
}

class _MessageTeacherSheetState extends ConsumerState<_MessageTeacherSheet> {
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

  Future<void> _message(PersonSearchResult person) async {
    if (_submitting) return;
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    final navigator = Navigator.of(context);
    setState(() => _submitting = true);
    final outcome = await ref.read(directMessageStarterProvider).start(person.userId);
    if (!mounted) return;
    switch (outcome) {
      case OpenConversation(:final location):
        // The new conversation should be in the list when the viewer returns.
        ref.invalidate(conversationListProvider);
        if (navigator.canPop()) navigator.pop();
        router.push(location);
      case CannotStartDm(:final message):
        setState(() => _submitting = false);
        messenger.toast(message);
    }
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
            Text(MessagingCopy.messageTeacherTitle, style: context.text.titleMedium),
            const SizedBox(height: Insets.md),
            TextField(
              key: const Key('message-teacher-search'),
              controller: _field,
              autofocus: true,
              onChanged: _onChanged,
              textInputAction: TextInputAction.search,
              decoration: const InputDecoration(
                hintText: MessagingCopy.messageTeacherHint,
                prefixIcon: Icon(Icons.search_rounded),
              ),
            ),
            const SizedBox(height: Insets.md),
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.4),
              child: _results(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _results() {
    if (_query.trim().isEmpty) {
      return const _Hint(text: MessagingCopy.messageTeacherPrompt);
    }
    final value = ref.watch(teacherSearchProvider(_query));
    return value.when(
      loading: () => const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      ),
      error: (error, _) => _Hint(
        text: MessagingCopy.teacherSearchError(error is PeopleException ? error.code : null),
      ),
      data: (page) {
        if (page.items.isEmpty) {
          return const _Hint(text: MessagingCopy.messageTeacherNoResults);
        }
        return ListView.builder(
          shrinkWrap: true,
          // One more row, for the next page, while the server has more.
          itemCount: page.items.length + (page.hasMore ? 1 : 0),
          itemBuilder: (context, index) {
            if (index == page.items.length) return _moreRow(page);
            final teacher = page.items[index];
            return ListTile(
              key: Key('message-teacher-${teacher.userId}'),
              leading: const Icon(Icons.school_outlined),
              title: Text(teacher.displayName ?? MessagingCopy.messageTeacherTitle),
              onTap: _submitting ? null : () => _message(teacher),
            );
          },
        );
      },
    );
  }

  Widget _moreRow(TeacherSearchState page) {
    if (page.loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(Insets.md),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return TextButton(
      key: const Key('message-teacher-more'),
      onPressed: () => ref.read(teacherSearchProvider(_query).notifier).loadMore(),
      child: Text(
        page.loadMoreFailed ? MessagingCopy.messageTeacherMoreFailed : MessagingCopy.messageTeacherMore,
      ),
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
