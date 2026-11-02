import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/theme/app_tokens.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import '../state/task_reports_state.dart';
import '../widgets/task_feedback.dart';

/// A reviewer's controls on one report (roadmap §6, ADR 0052 §10): approve
/// or request changes with a note (on the version shown), rewrite it, or
/// delete it. Approving an edited report is a new decision — an edit sends an
/// approved report back to review.
class ReportReviewPanel extends ConsumerStatefulWidget {
  const ReportReviewPanel({super.key, required this.detail});

  final ReportDetail detail;

  @override
  ConsumerState<ReportReviewPanel> createState() => _ReportReviewPanelState();
}

enum _Mode { idle, requestingChanges, editing }

class _ReportReviewPanelState extends ConsumerState<ReportReviewPanel> {
  final _text = TextEditingController();
  _Mode _mode = _Mode.idle;
  bool _busy = false;

  TaskReport get _report => widget.detail.report;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() act, String success) async {
    setState(() => _busy = true);
    final ok = await runTaskAct(context, act, success: success);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (ok) _mode = _Mode.idle;
    });
  }

  void _approve() => _run(
    () => ref
        .read(reportActionsProvider)
        .review(_report.id, version: _report.version, decision: ReviewDecision.approved),
    TasksCopy.approvedToast,
  );

  void _sendChangesRequest() {
    final note = _text.text.trim();
    if (note.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(TasksLabels.refusal('tasks.note_required'))));
      return;
    }
    _run(
      () => ref
          .read(reportActionsProvider)
          .review(
            _report.id,
            version: _report.version,
            decision: ReviewDecision.changesRequested,
            note: note,
          ),
      TasksCopy.changesRequestedToast,
    );
  }

  void _saveEdit() => _run(
    () => ref
        .read(reportActionsProvider)
        .edit(_report.id, version: _report.version, body: _text.text.trim()),
    TasksCopy.reportEdited,
  );

  Future<void> _delete() async {
    final sure = await confirmTaskAct(
      context,
      title: TasksCopy.deleteReport,
      question: TasksCopy.deleteReportQuestion,
    );
    if (!sure || !mounted) return;
    final router = GoRouter.of(context);
    setState(() => _busy = true);
    final ok = await runTaskAct(
      context,
      () => ref.read(reportActionsProvider).delete(_report.id),
      success: TasksCopy.reportDeleted,
    );
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok && router.canPop()) router.pop();
  }

  void _open(_Mode mode) => setState(() {
    _text.text = mode == _Mode.editing ? (widget.detail.latest?.body ?? '') : '';
    _mode = mode;
  });

  @override
  Widget build(BuildContext context) {
    if (_report.isDeleted) return const SizedBox.shrink();
    final pending = _report.isPendingReview;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_mode == _Mode.idle)
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            children: [
              if (pending) ...[
                FilledButton.icon(
                  key: const Key('report-approve'),
                  onPressed: _busy ? null : _approve,
                  icon: const Icon(Icons.verified_outlined),
                  label: const Text(TasksCopy.approve),
                ),
                OutlinedButton.icon(
                  key: const Key('report-request-changes'),
                  onPressed: _busy ? null : () => _open(_Mode.requestingChanges),
                  icon: const Icon(Icons.rate_review_outlined),
                  label: const Text(TasksCopy.requestChanges),
                ),
              ],
              OutlinedButton.icon(
                key: const Key('report-edit'),
                onPressed: _busy ? null : () => _open(_Mode.editing),
                icon: const Icon(Icons.edit_outlined),
                label: const Text(TasksCopy.editReport),
              ),
              TextButton.icon(
                key: const Key('report-delete'),
                onPressed: _busy ? null : _delete,
                icon: const Icon(Icons.delete_outline),
                label: const Text(TasksCopy.deleteReport),
              ),
            ],
          )
        else ...[
          TextField(
            key: const Key('report-text'),
            controller: _text,
            enabled: !_busy,
            minLines: 3,
            maxLines: 10,
            maxLength: _mode == _Mode.editing ? 20000 : 2000,
            decoration: InputDecoration(
              labelText: _mode == _Mode.editing ? TasksCopy.reportLabel : TasksCopy.noteField,
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: Insets.sm),
          Row(
            children: [
              FilledButton(
                key: const Key('report-send'),
                onPressed: _busy
                    ? null
                    : (_mode == _Mode.editing ? _saveEdit : _sendChangesRequest),
                child: Text(_mode == _Mode.editing ? TasksCopy.save : TasksCopy.requestChanges),
              ),
              const SizedBox(width: Insets.sm),
              TextButton(
                onPressed: _busy ? null : () => setState(() => _mode = _Mode.idle),
                child: const Text(TasksCopy.back),
              ),
            ],
          ),
        ],
      ],
    );
  }
}
