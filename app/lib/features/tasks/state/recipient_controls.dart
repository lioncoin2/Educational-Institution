import '../../../data/models/tasks/tasks.dart';

/// Which controls a recipient's task page offers — the server's completion
/// rules (ADR 0052 §4) mirrored as a courtesy; the server still decides.
///
///   - a COMPLETE button: completing is that button (with the report, if one
///     is required), after acknowledging when the task asks for it;
///   - no COMPLETE button but a required report: sending the report completes;
///   - neither: acknowledging completes.
class RecipientControls {
  const RecipientControls({
    required this.acknowledge,
    required this.complete,
    required this.completeWithReport,
    required this.editReport,
  });

  factory RecipientControls.of(MyTaskDetail detail) {
    final task = detail.task;
    final assignment = detail.assignment;
    final open = task.isActive && !assignment.isReassigned;
    final needsAck = task.offersAcknowledge && assignment.isPending;
    final canFinish =
        open && !assignment.isCompleted && (task.offersComplete || task.reportRequired);
    final report = detail.report;
    return RecipientControls(
      acknowledge: open && needsAck,
      complete: canFinish && !(task.offersAcknowledge && assignment.acknowledgedAt == null),
      completeWithReport: task.reportRequired,
      editReport: open && report != null && !report.isDeleted,
    );
  }

  /// Offer «تم الاستلام».
  final bool acknowledge;

  /// Offer completing (the button, or sending the report).
  final bool complete;

  /// Completing carries the report text.
  final bool completeWithReport;

  /// Offer rewriting the recipient's own report.
  final bool editReport;
}
