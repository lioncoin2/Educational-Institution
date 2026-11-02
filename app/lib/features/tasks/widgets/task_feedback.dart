import 'package:flutter/material.dart';

import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';

/// Asks before an act that changes a task's course (cancel, reopen, delete).
Future<bool> confirmTaskAct(
  BuildContext context, {
  required String title,
  required String question,
}) async {
  final answer = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(question),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text(TasksCopy.back),
        ),
        FilledButton(
          key: const Key('tasks-confirm'),
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text(TasksCopy.confirm),
        ),
      ],
    ),
  );
  return answer ?? false;
}

/// Runs one act and says how it went: [success] (or what [describe] makes of
/// the result) when the server accepted it, the refusal's sentence otherwise.
/// Answers whether it succeeded.
Future<bool> runTaskAct<T>(
  BuildContext context,
  Future<T> Function() act, {
  String? success,
  String Function(T result)? describe,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final result = await act();
    final message = describe?.call(result) ?? success;
    if (message != null) messenger.showSnackBar(SnackBar(content: Text(message)));
    return true;
  } on Object catch (error) {
    messenger.showSnackBar(SnackBar(content: Text(TasksLabels.error(error))));
    return false;
  }
}
