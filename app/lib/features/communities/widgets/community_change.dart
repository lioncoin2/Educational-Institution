import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../community_copy.dart';
import '../state/community_write.dart';

/// Asks before a change the viewer makes to a community — [question] names
/// what, and to whom. Only an explicit yes answers true: dismissing the
/// dialog is a no. A long name at a large text size scrolls, the answers
/// always in reach.
Future<bool> confirmCommunityChange(
  BuildContext context, {
  required String question,
  required String confirmLabel,
  bool destructive = false,
}) async {
  final yes = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      scrollable: true,
      title: Text(question),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text(CommunityCopy.cancel),
        ),
        TextButton(
          style: destructive
              ? TextButton.styleFrom(foregroundColor: context.colors.error)
              : null,
          onPressed: () => Navigator.pop(context, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return yes ?? false;
}

/// The 18 px spinner that takes a control's icon's place while its request
/// is on its way — the control itself is disabled meanwhile. It says
/// nothing to a screen reader: the control keeps its own name and stays a
/// button (a spinner's role merged into it would take that away, on the
/// web). Where it takes the label's place, the control names itself with
/// [Semantics].
class BusyIndicator extends StatelessWidget {
  const BusyIndicator({super.key});

  @override
  Widget build(BuildContext context) {
    return const ExcludeSemantics(
      child: SizedBox.square(
        dimension: 18,
        child: CircularProgressIndicator(strokeWidth: 2),
      ),
    );
  }
}

/// Says what became of a change the viewer asked for, through a messenger
/// held before the request (the widget that asked may be gone by now): why
/// not, when refused or unanswered; that it is done but its screen could not
/// be read again — offering [refresh] — when the read after it failed. A
/// change the viewer confirmed and that was never sent (its screen was
/// starting over) says so too; one that went through says nothing more.
void sayWriteOutcome(
  ScaffoldMessengerState messenger,
  WriteOutcome<Object?> outcome, {
  required VoidCallback refresh,
  bool confirmed = false,
}) {
  switch (outcome) {
    case WriteFailed(:final error):
      messenger.toast(CommunityCopy.writeFailed(error.code));
    case WriteDone(refreshed: false):
      messenger.toast(
        CommunityCopy.doneNotShown,
        action: SnackBarAction(
          label: CommunityCopy.refresh,
          onPressed: refresh,
        ),
      );
    case WriteNotSent() when confirmed:
      messenger.toast(CommunityCopy.notSent);
    case WriteDone() || WriteNotSent():
      break;
  }
}
