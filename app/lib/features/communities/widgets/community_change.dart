import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../community_copy.dart';

/// Asks before a change the viewer makes to a community — [question] names
/// what, and to whom. Only an explicit yes answers true: dismissing the
/// dialog is a no.
Future<bool> confirmCommunityChange(
  BuildContext context, {
  required String question,
  required String confirmLabel,
  bool destructive = false,
}) async {
  final yes = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
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
/// is on its way — the control itself is disabled meanwhile.
class BusyIndicator extends StatelessWidget {
  const BusyIndicator({super.key});

  @override
  Widget build(BuildContext context) {
    return const SizedBox.square(
      dimension: 18,
      child: CircularProgressIndicator(strokeWidth: 2),
    );
  }
}
