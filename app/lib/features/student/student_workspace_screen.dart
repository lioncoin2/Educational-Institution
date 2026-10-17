import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/academic.dart';
import '../../providers/app_providers.dart';
import '../messaging/widgets/start_direct_message_button.dart';
import 'state/student_enrollments_controller.dart';
import 'student_copy.dart';

/// حلقاتي — the signed-in student's own current enrollments. Read-only: it
/// lists the halaqat the server says this identity is actively enrolled in,
/// each with where it sits and its teachers by name and role. No classmate
/// roster (Q31), no controls, no progress — none is recorded, none invented.
class StudentWorkspaceScreen extends ConsumerWidget {
  const StudentWorkspaceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final workspace = ref.watch(studentEnrollmentsProvider);
    final demo = !ref.watch(backendModeProvider);
    // A student may start a teacher DM (Q6) when their account holds
    // `messaging.start_direct_teacher`. The server re-authorises every start,
    // so this only governs whether the affordance is offered — it grants
    // nothing. Mirrors the conversations screen.
    final canMessageTeacher = ref.watch(
      sessionUserProvider.select(
        (session) =>
            session.value?.can('messaging.start_direct_teacher') ?? false,
      ),
    );
    return Scaffold(
      appBar: AppBar(
        title: const Text(StudentCopy.workspaceTitle),
        actions: [
          IconButton(
            tooltip: StudentCopy.recordEntry,
            onPressed: () => context.push(Routes.studentRecord),
            icon: const Icon(Icons.history_edu_outlined),
          ),
          IconButton(
            tooltip: StudentCopy.refresh,
            onPressed: () => ref.invalidate(studentEnrollmentsProvider),
            icon: const Icon(Icons.refresh_rounded),
          ),
          const SizedBox(width: Insets.sm),
        ],
      ),
      body: SafeArea(
        top: false,
        child: AsyncView(
          value: workspace,
          onRetry: () => ref.invalidate(studentEnrollmentsProvider),
          errorBuilder: (context, error) => _ErrorView(
            message: StudentCopy.workspaceFailed(
              error is AcademicException ? error.code : 'unknown',
            ),
            onRetry: () => ref.invalidate(studentEnrollmentsProvider),
          ),
          builder: (context, state) {
            if (state.enrollments.isEmpty) {
              return const SingleChildScrollView(
                child: EmptyState(
                  icon: Icons.school_outlined,
                  title: StudentCopy.empty,
                  message: StudentCopy.emptyMessage,
                ),
              );
            }
            return RefreshIndicator(
              onRefresh: () =>
                  ref.read(studentEnrollmentsProvider.notifier).refresh(),
              child: ListView.builder(
                padding: const EdgeInsets.only(
                  top: Insets.md,
                  bottom: Insets.giant,
                ),
                itemCount: state.enrollments.length + 1,
                itemBuilder: (context, index) {
                  if (index == 0) {
                    return _Header(demo: demo, truncated: state.truncated);
                  }
                  return ResponsiveBody(
                    child: Padding(
                      padding: const EdgeInsets.only(bottom: Insets.sm),
                      child: _EnrollmentCard(
                        enrollment: state.enrollments[index - 1],
                        canMessageTeacher: canMessageTeacher,
                      ),
                    ),
                  );
                },
              ),
            );
          },
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.demo, required this.truncated});

  final bool demo;
  final bool truncated;

  @override
  Widget build(BuildContext context) {
    if (!demo && !truncated) return const SizedBox.shrink();
    return ResponsiveBody(
      child: Padding(
        padding: const EdgeInsets.only(bottom: Insets.sm),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (demo) const MockBanner(message: StudentCopy.demoBanner),
            if (truncated)
              Padding(
                padding: const EdgeInsets.only(top: Insets.sm),
                child: Text(
                  StudentCopy.truncatedNote,
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _EnrollmentCard extends StatelessWidget {
  const _EnrollmentCard({
    required this.enrollment,
    required this.canMessageTeacher,
  });

  final MyEnrollment enrollment;
  final bool canMessageTeacher;

  @override
  Widget build(BuildContext context) {
    final placement = enrollment.placement;
    return AppCard(
      semanticLabel: placement.halaqa.name,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.menu_book_outlined, color: context.colors.primary),
              const SizedBox(width: Insets.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(placement.halaqa.name, style: context.text.titleSmall),
                    const SizedBox(height: 2),
                    Text(
                      '${placement.section.name} · ${placement.program.name}',
                      style: context.text.bodySmall?.copyWith(
                        color: context.colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: Insets.md),
          Text(
            StudentCopy.teachersLabel,
            style: context.text.labelMedium?.copyWith(
              color: context.colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: Insets.xs),
          if (enrollment.teachers.isEmpty)
            Text(StudentCopy.noTeachers, style: context.text.bodySmall)
          else
            ...enrollment.teachers.map(
              (teacher) => _TeacherRow(
                teacher: teacher,
                canMessageTeacher: canMessageTeacher,
              ),
            ),
        ],
      ),
    );
  }
}

/// One teacher of the student's halaqa: their name and role, and — when the
/// viewer may start a teacher DM and the account still exists — a button that
/// opens (or reuses) the direct conversation with exactly this teacher's id.
class _TeacherRow extends StatelessWidget {
  const _TeacherRow({required this.teacher, required this.canMessageTeacher});

  final HalaqaTeacher teacher;
  final bool canMessageTeacher;

  @override
  Widget build(BuildContext context) {
    // The name is null only when the account is gone; there is no one to reach,
    // so no message action is offered for it.
    final reachable = teacher.displayName != null;
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Row(
        children: [
          Expanded(
            child: Text(
              '${teacher.displayName ?? StudentCopy.unnamed} — '
              '${StudentCopy.role(teacher.role)}',
              style: context.text.bodyMedium,
            ),
          ),
          if (canMessageTeacher && reachable)
            StartDirectMessageButton(
              key: Key('message-teacher-${teacher.userId}'),
              userId: teacher.userId,
              label: StudentCopy.messageTeacher,
            ),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(Insets.xxl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.cloud_off_rounded,
            size: 40,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(height: Insets.md),
          Text(
            message,
            textAlign: TextAlign.center,
            style: context.text.titleMedium,
          ),
          const SizedBox(height: Insets.md),
          OutlinedButton(
            onPressed: onRetry,
            child: const Text(StudentCopy.refresh),
          ),
        ],
      ),
    );
  }
}
