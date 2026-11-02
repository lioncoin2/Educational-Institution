/// What the app sends to the tasks API (ADR 0052): a task to publish, an edit,
/// a re-publish, and the shared filters of search, reports, dashboard, export.
library;

import 'task_vocabulary.dart';

/// A task's content and settings, as the composer collects them.
class TaskDraft {
  const TaskDraft({
    required this.title,
    required this.body,
    required this.kind,
    required this.buttons,
    required this.reportRequired,
    required this.approvalMode,
    required this.audiences,
    this.communityId,
    this.templateId,
  });

  final String title;
  final String body;
  final TaskKind kind;
  final Set<TaskButton> buttons;
  final bool reportRequired;
  final ApprovalMode approvalMode;
  final Set<TaskAudience> audiences;

  /// Narrows the audiences to the members of one existing community.
  final String? communityId;

  /// The template this task was started from, recorded on the task.
  final String? templateId;

  Map<String, Object?> toJson() => {
    'title': title,
    'body': body,
    'kind': kind.wire,
    'buttons': [for (final b in TaskButton.selectable) if (buttons.contains(b)) b.wire],
    'reportRequired': reportRequired,
    'approvalMode': approvalMode.wire,
    'audiences': [for (final a in TaskAudience.selectable) if (audiences.contains(a)) a.wire],
    'communityId': ?communityId,
    'templateId': ?templateId,
  };
}

/// An edit of a published task. Only the fields given are changed; the server
/// refuses a settings change once anyone has responded (`tasks.settings_locked`).
class TaskEdit {
  const TaskEdit({
    required this.revision,
    this.title,
    this.body,
    this.kind,
    this.buttons,
    this.reportRequired,
    this.approvalMode,
    this.requireReacknowledge = false,
  });

  /// The revision the editor started from (`tasks.revision_conflict` if stale).
  final int revision;
  final String? title;
  final String? body;
  final TaskKind? kind;
  final Set<TaskButton>? buttons;
  final bool? reportRequired;
  final ApprovalMode? approvalMode;

  /// Ask everyone who acknowledged to acknowledge the edited task again.
  final bool requireReacknowledge;

  bool get changesSettings =>
      kind != null || buttons != null || reportRequired != null || approvalMode != null;

  Map<String, Object?> toJson() => {
    'revision': revision,
    'title': ?title,
    'body': ?body,
    'kind': ?kind?.wire,
    if (buttons case final chosen?)
      'buttons': [for (final b in TaskButton.selectable) if (chosen.contains(b)) b.wire],
    'reportRequired': ?reportRequired,
    'approvalMode': ?approvalMode?.wire,
    if (requireReacknowledge) 'requireReacknowledge': true,
  };
}

/// The common filters (roadmap §12–§15). Empty fields are not sent.
class TaskFilter {
  const TaskFilter({
    this.from,
    this.to,
    this.audience,
    this.communityId,
    this.personId,
    this.kind,
    this.state,
    this.reportStatus,
    this.text,
  });

  static const none = TaskFilter();

  /// Published at or after [from], before [to].
  final DateTime? from;
  final DateTime? to;
  final TaskAudience? audience;
  final String? communityId;
  final String? personId;
  final TaskKind? kind;
  final TaskState? state;
  final ReportStatus? reportStatus;
  final String? text;

  bool get isEmpty => toQuery().isEmpty;

  Map<String, String> toQuery() {
    final query = text?.trim();
    return {
      if (from case final at?) 'from': at.toUtc().toIso8601String(),
      if (to case final at?) 'to': at.toUtc().toIso8601String(),
      'audience': ?audience?.wire,
      if (communityId case final id? when id.isNotEmpty) 'communityId': id,
      if (personId case final id? when id.isNotEmpty) 'personId': id,
      'kind': ?kind?.wire,
      'state': ?state?.wire,
      'reportStatus': ?reportStatus?.wire,
      if (query != null && query.isNotEmpty) 'q': query,
    };
  }

  TaskFilter copyWith({
    DateTime? Function()? from,
    DateTime? Function()? to,
    TaskAudience? Function()? audience,
    TaskKind? Function()? kind,
    TaskState? Function()? state,
    ReportStatus? Function()? reportStatus,
    String? Function()? text,
  }) => TaskFilter(
    from: from == null ? this.from : from(),
    to: to == null ? this.to : to(),
    audience: audience == null ? this.audience : audience(),
    communityId: communityId,
    personId: personId,
    kind: kind == null ? this.kind : kind(),
    state: state == null ? this.state : state(),
    reportStatus: reportStatus == null ? this.reportStatus : reportStatus(),
    text: text == null ? this.text : text(),
  );

  @override
  bool operator ==(Object other) =>
      other is TaskFilter && _sameQuery(other.toQuery(), toQuery());

  @override
  int get hashCode => Object.hashAllUnordered(toQuery().entries.map((e) => '${e.key}=${e.value}'));

  static bool _sameQuery(Map<String, String> a, Map<String, String> b) =>
      a.length == b.length && a.entries.every((e) => b[e.key] == e.value);
}
