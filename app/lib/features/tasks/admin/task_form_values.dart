import '../../../data/models/tasks/tasks.dart';

/// What must be fixed before a task can be sent.
enum FormProblem { title, audience, response }

/// What the composer holds while it is being filled — and how it becomes a
/// [TaskDraft] (publish, re-publish, template) or a [TaskEdit] (an edit that
/// sends only what changed).
class TaskFormValues {
  TaskFormValues({
    this.title = '',
    this.body = '',
    this.kind = TaskKind.general,
    Set<TaskButton>? buttons,
    this.reportRequired = false,
    this.approvalMode = ApprovalMode.manual,
    Set<TaskAudience>? audiences,
    this.communityId,
    this.templateId,
  }) : buttons = buttons ?? {TaskButton.acknowledge, TaskButton.complete},
       audiences = audiences ?? {TaskAudience.teachers};

  factory TaskFormValues.ofTask(TaskItem task) => TaskFormValues(
    title: task.title,
    body: task.body,
    kind: task.kind,
    buttons: task.buttons.where(TaskButton.selectable.contains).toSet(),
    reportRequired: task.reportRequired,
    approvalMode: task.approvalMode,
    audiences: task.audiences.where(TaskAudience.selectable.contains).toSet(),
    communityId: task.communityId,
  );

  factory TaskFormValues.ofTemplate(TaskTemplate template) => TaskFormValues(
    title: template.title,
    body: template.body,
    kind: template.kind,
    buttons: template.buttons.where(TaskButton.selectable.contains).toSet(),
    reportRequired: template.reportRequired,
    approvalMode: template.approvalMode,
    audiences: template.audiences.where(TaskAudience.selectable.contains).toSet(),
    communityId: template.communityId,
    templateId: template.id,
  );

  String title;
  String body;
  TaskKind kind;
  final Set<TaskButton> buttons;
  bool reportRequired;
  ApprovalMode approvalMode;
  final Set<TaskAudience> audiences;
  String? communityId;
  final String? templateId;

  /// The first thing to fix before sending, or null. The server checks again.
  FormProblem? problem({required bool needsAudience}) {
    if (title.trim().isEmpty) return FormProblem.title;
    if (needsAudience && audiences.isEmpty) return FormProblem.audience;
    if (buttons.isEmpty && !reportRequired) return FormProblem.response;
    return null;
  }

  TaskDraft toDraft() => TaskDraft(
    title: title.trim(),
    body: body.trim(),
    kind: kind,
    buttons: {...buttons},
    reportRequired: reportRequired,
    approvalMode: approvalMode,
    audiences: {...audiences},
    communityId: communityId,
    templateId: templateId,
  );

  /// An edit of [task] carrying only the fields that differ from it.
  TaskEdit toEdit(TaskItem task, {required bool requireReacknowledge}) {
    final sameButtons =
        buttons.length == task.buttons.length && task.buttons.every(buttons.contains);
    return TaskEdit(
      revision: task.revision,
      title: title.trim() == task.title ? null : title.trim(),
      body: body.trim() == task.body ? null : body.trim(),
      kind: kind == task.kind ? null : kind,
      buttons: sameButtons ? null : {...buttons},
      reportRequired: reportRequired == task.reportRequired ? null : reportRequired,
      approvalMode: approvalMode == task.approvalMode ? null : approvalMode,
      requireReacknowledge: requireReacknowledge,
    );
  }
}
