import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/platform/file_saver.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/tasks/tasks.dart';
import '../../../providers/tasks_providers.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';

/// Downloads the export under [filter] (ADR 0052 §12): CSV that opens in
/// Excel, or the print-ready HTML report the browser prints or saves as PDF.
class TaskExportButtons extends ConsumerStatefulWidget {
  const TaskExportButtons({super.key, required this.filter});

  final TaskFilter filter;

  @override
  ConsumerState<TaskExportButtons> createState() => _TaskExportButtonsState();
}

class _TaskExportButtonsState extends ConsumerState<TaskExportButtons> {
  bool _busy = false;

  Future<void> _export(TaskExportFormat format) async {
    final messenger = ScaffoldMessenger.of(context);
    void say(String text) => messenger.showSnackBar(SnackBar(content: Text(text)));
    setState(() => _busy = true);
    try {
      final file = await ref
          .read(taskInsightsRepositoryProvider)
          .export(filter: widget.filter, format: format);
      saveBytesAsFile(
        file.bytes,
        fileName: file.fileName,
        mimeType: format == TaskExportFormat.csv ? 'text/csv' : 'text/html',
      );
      say(switch ((file.truncated, format)) {
        (true, _) => TasksCopy.exportTruncated,
        (false, TaskExportFormat.html) => '${TasksCopy.exported}. ${TasksCopy.printHint}',
        (false, TaskExportFormat.csv) => TasksCopy.exported,
      });
    } on UnsupportedError {
      say(TasksCopy.exportUnsupported);
    } on Object catch (error) {
      say(TasksLabels.error(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: Insets.sm,
      runSpacing: Insets.sm,
      children: [
        FilledButton.tonalIcon(
          key: const Key('tasks-export-csv'),
          onPressed: _busy ? null : () => _export(TaskExportFormat.csv),
          icon: const Icon(Icons.table_view_outlined),
          label: const Text(TasksCopy.exportCsv),
        ),
        OutlinedButton.icon(
          key: const Key('tasks-export-html'),
          onPressed: _busy ? null : () => _export(TaskExportFormat.html),
          icon: const Icon(Icons.print_outlined),
          label: const Text(TasksCopy.exportHtml),
        ),
      ],
    );
  }
}
