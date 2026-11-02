import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import '../state/my_tasks_state.dart';
import '../state/recipient_controls.dart';
import '../widgets/task_feedback.dart';
import '../widgets/task_format.dart';
import '../widgets/task_pill.dart';

/// The recipient's side of one task: acknowledge, complete (with the report
/// when one is required), and their report — its state, its text, and a
/// rewrite. Every act goes to the server; nothing changes on screen until it
/// has accepted it.
class MyTaskResponsePanel extends ConsumerStatefulWidget {
  const MyTaskResponsePanel({super.key, required this.detail});

  final MyTaskDetail detail;

  @override
  ConsumerState<MyTaskResponsePanel> createState() => _MyTaskResponsePanelState();
}

class _MyTaskResponsePanelState extends ConsumerState<MyTaskResponsePanel> {
  final _report = TextEditingController();
  bool _busy = false;
  bool _rewriting = false;

  @override
  void dispose() {
    _report.dispose();
    super.dispose();
  }

  String get _assignmentId => widget.detail.assignment.id;

  Future<void> _run(Future<void> Function() act, String success) async {
    setState(() => _busy = true);
    final ok = await runTaskAct(context, act, success: success);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (ok) _rewriting = false;
    });
  }

  void _acknowledge() =>
      _run(() => ref.read(myTaskResponsesProvider).acknowledge(_assignmentId), TasksCopy.acknowledged);

  void _complete({required bool withReport}) {
    final text = _report.text.trim();
    if (withReport && text.isEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(TasksLabels.refusal('tasks.report_required'))));
      return;
    }
    _run(
      () => ref
          .read(myTaskResponsesProvider)
          .complete(_assignmentId, report: withReport ? text : null),
      withReport ? TasksCopy.reportSent : TasksCopy.completed,
    );
  }

  void _startRewrite() => setState(() {
    _report.text = widget.detail.latest?.body ?? '';
    _rewriting = true;
  });

  void _rewrite(TaskReport report) => _run(
    () => ref
        .read(myTaskResponsesProvider)
        .writeReport(_assignmentId, version: report.version, body: _report.text.trim()),
    TasksCopy.reportSent,
  );

  @override
  Widget build(BuildContext context) {
    final detail = widget.detail;
    final controls = RecipientControls.of(detail);
    final report = detail.report;
    final completeLabel = detail.task.offersComplete
        ? TasksLabels.button(TaskButton.complete)
        : TasksCopy.sendReport;
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (controls.acknowledge)
            FilledButton.icon(
              key: const Key('my-task-acknowledge'),
              onPressed: _busy ? null : _acknowledge,
              icon: const Icon(Icons.mark_email_read_outlined),
              label: Text(TasksLabels.button(TaskButton.acknowledge)),
            ),
          if (controls.complete) ...[
            if (controls.acknowledge) const SizedBox(height: Insets.md),
            if (controls.completeWithReport) ...[
              Text(TasksCopy.reportRequiredHint, style: context.text.bodySmall),
              const SizedBox(height: Insets.sm),
              _ReportField(controller: _report, enabled: !_busy),
              const SizedBox(height: Insets.sm),
            ],
            FilledButton.icon(
              key: const Key('my-task-complete'),
              onPressed: _busy ? null : () => _complete(withReport: controls.completeWithReport),
              icon: const Icon(Icons.task_alt),
              label: Text(completeLabel),
            ),
          ],
          if (report != null) ...[
            if (controls.acknowledge || controls.complete) const SizedBox(height: Insets.lg),
            _ReportState(report: report, latest: detail.latest),
            if (controls.editReport && !_rewriting)
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: TextButton.icon(
                  key: const Key('my-task-rewrite'),
                  onPressed: _busy ? null : _startRewrite,
                  icon: const Icon(Icons.edit_outlined),
                  label: const Text(TasksCopy.updateReport),
                ),
              ),
            if (_rewriting) ...[
              const SizedBox(height: Insets.sm),
              _ReportField(controller: _report, enabled: !_busy),
              const SizedBox(height: Insets.sm),
              FilledButton(
                key: const Key('my-task-rewrite-send'),
                onPressed: _busy ? null : () => _rewrite(report),
                child: const Text(TasksCopy.sendReport),
              ),
            ],
          ],
          if (!controls.acknowledge && !controls.complete && report == null)
            Text(TasksLabels.assignment(detail.assignment.status), style: context.text.bodyMedium),
        ],
      ),
    );
  }
}

class _ReportField extends StatelessWidget {
  const _ReportField({required this.controller, required this.enabled});

  final TextEditingController controller;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return TextField(
      key: const Key('my-task-report-field'),
      controller: controller,
      enabled: enabled,
      minLines: 3,
      maxLines: 10,
      maxLength: 20000,
      decoration: const InputDecoration(
        labelText: TasksCopy.reportLabel,
        hintText: TasksCopy.reportHint,
        border: OutlineInputBorder(),
      ),
    );
  }
}

class _ReportState extends StatelessWidget {
  const _ReportState({required this.report, required this.latest});

  final TaskReport report;
  final ReportVersion? latest;

  @override
  Widget build(BuildContext context) {
    final approval = switch ((report.approvedAt, report.approvedBy)) {
      (null, _) => null,
      (_, null) => TasksCopy.approvedAutomatically,
      (_, final who?) => TasksCopy.approvedBy(TaskFormat.person(who)),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(TasksCopy.reportLabel, style: context.text.labelLarge),
            const SizedBox(width: Insets.sm),
            TaskPill.report(report.status),
            const Spacer(),
            Text(TasksCopy.versionLine(report.version), style: context.text.bodySmall),
          ],
        ),
        if (approval != null) Text(approval, style: context.text.bodySmall),
        if (latest case final version?) ...[
          const SizedBox(height: Insets.sm),
          SelectableText(version.body, style: context.text.bodyMedium),
        ],
      ],
    );
  }
}
