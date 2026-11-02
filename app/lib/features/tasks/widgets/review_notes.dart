import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import 'task_format.dart';

/// The reviewers' decisions on a report, oldest first: who decided what, on
/// which version, when, and the note they left.
class ReviewNotes extends StatelessWidget {
  const ReviewNotes({super.key, required this.reviews});

  final List<ReportReview> reviews;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final review in reviews)
          Padding(
            padding: const EdgeInsets.only(bottom: Insets.sm),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${TasksLabels.decision(review.decision)} · '
                  '${TasksCopy.versionLine(review.version)} · '
                  '${TaskFormat.person(review.reviewer)} · ${TaskFormat.when(review.decidedAt)}',
                  style: context.text.labelMedium,
                ),
                if (review.note case final note?)
                  Padding(
                    padding: const EdgeInsets.only(top: Insets.xs),
                    child: Text(note, style: context.text.bodyMedium),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}
