import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../community_copy.dart';

/// Shows a new invitation's [link] — the one time it can be: the server
/// keeps no way to show it again. It is for the viewer to copy (or, where
/// the clipboard is out of reach, to select); closing the sheet forgets it.
Future<void> showOneTimeLinkSheet(BuildContext context, Uri link) =>
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => _OneTimeLinkSheet(link: link.toString()),
    );

class _OneTimeLinkSheet extends StatefulWidget {
  const _OneTimeLinkSheet({required this.link});

  final String link;

  @override
  State<_OneTimeLinkSheet> createState() => _OneTimeLinkSheetState();
}

class _OneTimeLinkSheetState extends State<_OneTimeLinkSheet> {
  bool _copied = false;
  bool _copyFailed = false;

  /// A browser may refuse the clipboard (outside a secure context): the
  /// link stays on screen, selectable, and the sheet says so.
  Future<void> _copy() async {
    try {
      await Clipboard.setData(ClipboardData(text: widget.link));
    } on Exception {
      if (mounted) setState(() => _copyFailed = true);
      return;
    }
    if (!mounted) return;
    setState(() {
      _copied = true;
      _copyFailed = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.symmetric(
          horizontal: context.gutter,
          vertical: Insets.sm,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(CommunityCopy.linkSheetTitle, style: context.text.titleLarge),
            const SizedBox(height: Insets.sm),
            Text(CommunityCopy.linkSheetNote, style: context.text.bodyMedium),
            const SizedBox(height: Insets.lg),
            Container(
              padding: const EdgeInsets.all(Insets.md),
              decoration: BoxDecoration(
                color: context.colors.surfaceContainerLowest,
                borderRadius: Radii.brMd,
                border: Border.all(color: context.colors.outlineVariant),
              ),
              // An address reads left to right, whatever the page's
              // direction.
              child: SelectableText(
                widget.link,
                textDirection: TextDirection.ltr,
                style: context.text.bodyMedium,
              ),
            ),
            if (_copyFailed) ...[
              const SizedBox(height: Insets.sm),
              Text(
                CommunityCopy.copyFailed,
                style: context.text.bodySmall?.copyWith(
                  color: context.colors.error,
                ),
              ),
            ],
            const SizedBox(height: Insets.lg),
            FilledButton.icon(
              onPressed: _copy,
              icon: Icon(_copied ? Icons.check_rounded : Icons.copy_rounded),
              label: Text(
                _copied ? CommunityCopy.linkCopied : CommunityCopy.copyLink,
              ),
            ),
            const SizedBox(height: Insets.sm),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text(CommunityCopy.done),
            ),
            const SizedBox(height: Insets.lg),
          ],
        ),
      ),
    );
  }
}
