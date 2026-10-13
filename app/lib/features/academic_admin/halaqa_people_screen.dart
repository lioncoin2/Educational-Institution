import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/foundations/mock_ribbon.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../data/models/academic.dart';
import '../../providers/app_providers.dart';
import 'academic_people_copy.dart';
import 'state/halaqa_people_controller.dart';
import 'widgets/person_picker_sheet.dart';

/// Administering who studies and who teaches in one halaqa, for a holder of
/// `academic.manage` (OWNER/ADMIN). People are found through the institution
/// directory (`people.read`); the server re-authorises every write and confirms
/// the account is an eligible student or teacher — a refusal is said in words.
/// Ending preserves history. Nothing here is self-enrolment or self-assignment.
class HalaqaPeopleScreen extends ConsumerWidget {
  const HalaqaPeopleScreen({super.key, required this.halaqaId});

  final String halaqaId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final canManage = ref.watch(
      sessionUserProvider.select(
        (session) => session.value?.can('academic.manage') ?? false,
      ),
    );
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text(AcademicPeopleCopy.screenTitle),
          actions: [
            IconButton(
              tooltip: AcademicPeopleCopy.refresh,
              onPressed: () {
                ref.invalidate(halaqaRosterProvider(halaqaId));
                ref.invalidate(halaqaTeachersProvider(halaqaId));
              },
              icon: const Icon(Icons.refresh_rounded),
            ),
            const SizedBox(width: Insets.sm),
          ],
          bottom: const TabBar(
            tabs: [
              Tab(text: AcademicPeopleCopy.studentsTab),
              Tab(text: AcademicPeopleCopy.teachersTab),
            ],
          ),
        ),
        body: SafeArea(
          top: false,
          child: TabBarView(
            children: [
              _StudentsTab(halaqaId: halaqaId, canManage: canManage),
              _TeachersTab(halaqaId: halaqaId, canManage: canManage),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Students ───────────────────────────────────────────────────────────────

class _StudentsTab extends ConsumerWidget {
  const _StudentsTab({required this.halaqaId, required this.canManage});

  final String halaqaId;
  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roster = ref.watch(halaqaRosterProvider(halaqaId));
    final demo = !ref.watch(backendModeProvider);
    return AsyncView(
      value: roster,
      onRetry: () => ref.invalidate(halaqaRosterProvider(halaqaId)),
      builder: (context, state) {
        return RefreshIndicator(
          onRefresh: () =>
              ref.read(halaqaRosterProvider(halaqaId).notifier).refresh(),
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: Insets.giant),
            itemCount: state.items.length + 2,
            itemBuilder: (context, index) {
              if (index == 0) {
                return _Head(
                  demo: demo,
                  canManage: canManage,
                  label: AcademicPeopleCopy.enrollStudent,
                  buttonKey: const Key('enroll-student-button'),
                  icon: Icons.person_add_alt_1_outlined,
                  onAdd: () => _enroll(context, ref, halaqaId),
                );
              }
              if (index == state.items.length + 1) {
                if (state.items.isEmpty) {
                  return const SingleChildScrollView(
                    child: EmptyState(
                      icon: Icons.groups_outlined,
                      title: AcademicPeopleCopy.noStudents,
                      message: AcademicPeopleCopy.noStudentsMessage,
                    ),
                  );
                }
                return _Footer(
                  hasMore: state.hasMore,
                  loadingMore: state.loadingMore,
                  failed: state.loadMoreFailed,
                  onMore: () => ref
                      .read(halaqaRosterProvider(halaqaId).notifier)
                      .loadMore(),
                );
              }
              final entry = state.items[index - 1];
              return ResponsiveBody(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Insets.sm),
                  child: _PersonCard(
                    name: entry.student.displayName,
                    active: entry.student.active,
                    subtitle: AcademicPeopleCopy.enrollmentStatus(
                      entry.enrollment.status,
                    ),
                    icon: Icons.person_outline,
                    onEnd: canManage
                        ? () => _endEnrollment(context, ref, halaqaId, entry)
                        : null,
                    endLabel: AcademicPeopleCopy.endEnrollment,
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }
}

// ── Teachers ───────────────────────────────────────────────────────────────

class _TeachersTab extends ConsumerWidget {
  const _TeachersTab({required this.halaqaId, required this.canManage});

  final String halaqaId;
  final bool canManage;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final teachers = ref.watch(halaqaTeachersProvider(halaqaId));
    final demo = !ref.watch(backendModeProvider);
    return AsyncView(
      value: teachers,
      onRetry: () => ref.invalidate(halaqaTeachersProvider(halaqaId)),
      builder: (context, state) {
        return RefreshIndicator(
          onRefresh: () =>
              ref.read(halaqaTeachersProvider(halaqaId).notifier).refresh(),
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: Insets.giant),
            itemCount: state.items.length + 2,
            itemBuilder: (context, index) {
              if (index == 0) {
                return _Head(
                  demo: demo,
                  canManage: canManage,
                  label: AcademicPeopleCopy.assignTeacher,
                  buttonKey: const Key('assign-teacher-button'),
                  icon: Icons.school_outlined,
                  onAdd: () => _assign(context, ref, halaqaId),
                );
              }
              if (index == state.items.length + 1) {
                if (state.items.isEmpty) {
                  return const SingleChildScrollView(
                    child: EmptyState(
                      icon: Icons.school_outlined,
                      title: AcademicPeopleCopy.noTeachers,
                      message: AcademicPeopleCopy.noTeachersMessage,
                    ),
                  );
                }
                return _Footer(
                  hasMore: state.hasMore,
                  loadingMore: state.loadingMore,
                  failed: state.loadMoreFailed,
                  onMore: () => ref
                      .read(halaqaTeachersProvider(halaqaId).notifier)
                      .loadMore(),
                );
              }
              final entry = state.items[index - 1];
              return ResponsiveBody(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Insets.sm),
                  child: _PersonCard(
                    name: entry.teacher.displayName,
                    active: entry.teacher.active,
                    subtitle:
                        '${AcademicPeopleCopy.role(entry.assignment.role)} · '
                        '${AcademicPeopleCopy.assignmentStatus(entry.assignment.status)}',
                    icon: Icons.school_outlined,
                    onEnd: canManage
                        ? () => _endAssignment(context, ref, halaqaId, entry)
                        : null,
                    endLabel: AcademicPeopleCopy.endAssignment,
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }
}

// ── Shared widgets ───────────────────────────────────────────────────────────

class _Head extends StatelessWidget {
  const _Head({
    required this.demo,
    required this.canManage,
    required this.label,
    required this.buttonKey,
    required this.icon,
    required this.onAdd,
  });

  final bool demo;
  final bool canManage;
  final String label;
  final Key buttonKey;
  final IconData icon;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return ResponsiveBody(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (demo)
            const Padding(
              padding: EdgeInsets.only(top: Insets.md),
              child: MockBanner(message: AcademicPeopleCopy.demoBanner),
            ),
          if (canManage)
            Padding(
              padding: const EdgeInsets.only(top: Insets.md),
              child: FilledButton.icon(
                key: buttonKey,
                onPressed: onAdd,
                icon: Icon(icon),
                label: Text(label),
              ),
            )
          else
            const SizedBox(height: Insets.md),
        ],
      ),
    );
  }
}

class _PersonCard extends StatelessWidget {
  const _PersonCard({
    required this.name,
    required this.active,
    required this.subtitle,
    required this.icon,
    required this.onEnd,
    required this.endLabel,
  });

  final String? name;
  final bool active;
  final String subtitle;
  final IconData icon;
  final VoidCallback? onEnd;
  final String endLabel;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: context.colors.onSurfaceVariant),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name ?? AcademicPeopleCopy.unnamed,
                  style: context.text.titleSmall,
                ),
                const SizedBox(height: 2),
                Text(
                  active
                      ? subtitle
                      : '$subtitle · ${AcademicPeopleCopy.inactiveAccount}',
                  style: context.text.bodySmall?.copyWith(
                    color: context.colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          if (onEnd != null)
            PopupMenuButton<String>(
              icon: const Icon(Icons.more_vert),
              onSelected: (_) => onEnd!(),
              itemBuilder: (context) => [
                PopupMenuItem(value: 'end', child: Text(endLabel)),
              ],
            ),
        ],
      ),
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({
    required this.hasMore,
    required this.loadingMore,
    required this.failed,
    required this.onMore,
  });

  final bool hasMore;
  final bool loadingMore;
  final bool failed;
  final VoidCallback onMore;

  @override
  Widget build(BuildContext context) {
    if (!hasMore) return const SizedBox(height: Insets.lg);
    if (loadingMore) {
      return const Padding(
        padding: EdgeInsets.all(Insets.lg),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return Center(
      child: TextButton(
        onPressed: onMore,
        child: Text(
          failed
              ? AcademicPeopleCopy.loadMoreFailed
              : AcademicPeopleCopy.loadMore,
        ),
      ),
    );
  }
}

// ── Actions ──────────────────────────────────────────────────────────────

Future<void> _enroll(
  BuildContext context,
  WidgetRef ref,
  String halaqaId,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final person = await showPersonPicker(
    context,
    title: AcademicPeopleCopy.pickStudentTitle,
  );
  if (person == null) return;
  try {
    await ref
        .read(halaqaRosterProvider(halaqaId).notifier)
        .enroll(person.userId);
  } on AcademicException catch (error) {
    messenger.toast(AcademicPeopleCopy.relationFailed(error.code));
    return;
  }
  messenger.toast(AcademicPeopleCopy.enrolled);
}

Future<void> _assign(
  BuildContext context,
  WidgetRef ref,
  String halaqaId,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final person = await showPersonPicker(
    context,
    title: AcademicPeopleCopy.pickTeacherTitle,
  );
  if (person == null || !context.mounted) return;
  final role = await _chooseRole(context);
  if (role == null) return;
  try {
    await ref
        .read(halaqaTeachersProvider(halaqaId).notifier)
        .assign(person.userId, role: role);
  } on AcademicException catch (error) {
    messenger.toast(AcademicPeopleCopy.relationFailed(error.code));
    return;
  }
  messenger.toast(AcademicPeopleCopy.assigned);
}

Future<void> _endEnrollment(
  BuildContext context,
  WidgetRef ref,
  String halaqaId,
  HalaqaRosterEntry entry,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final outcome = await showDialog<EnrollmentOutcome>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text(AcademicPeopleCopy.endEnrollment),
      content: Text(
        AcademicPeopleCopy.endEnrollmentQuestion(
          entry.student.displayName ?? AcademicPeopleCopy.unnamed,
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text(AcademicPeopleCopy.cancel),
        ),
        TextButton(
          onPressed: () =>
              Navigator.of(context).pop(EnrollmentOutcome.withdrawn),
          child: Text(
            AcademicPeopleCopy.outcomeLabel(EnrollmentOutcome.withdrawn),
          ),
        ),
        FilledButton(
          onPressed: () =>
              Navigator.of(context).pop(EnrollmentOutcome.completed),
          child: Text(
            AcademicPeopleCopy.outcomeLabel(EnrollmentOutcome.completed),
          ),
        ),
      ],
    ),
  );
  if (outcome == null) return;
  try {
    await ref
        .read(halaqaRosterProvider(halaqaId).notifier)
        .endEnrollment(entry.enrollment.id, outcome: outcome);
  } on AcademicException catch (error) {
    messenger.toast(AcademicPeopleCopy.relationFailed(error.code));
    return;
  }
  messenger.toast(AcademicPeopleCopy.enrollmentEnded);
}

Future<void> _endAssignment(
  BuildContext context,
  WidgetRef ref,
  String halaqaId,
  HalaqaTeacherEntry entry,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      content: Text(
        AcademicPeopleCopy.endAssignmentQuestion(
          entry.teacher.displayName ?? AcademicPeopleCopy.unnamed,
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text(AcademicPeopleCopy.cancel),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text(AcademicPeopleCopy.confirmEnd),
        ),
      ],
    ),
  );
  if (confirmed != true) return;
  try {
    await ref
        .read(halaqaTeachersProvider(halaqaId).notifier)
        .endAssignment(entry.assignment.id);
  } on AcademicException catch (error) {
    messenger.toast(AcademicPeopleCopy.relationFailed(error.code));
    return;
  }
  messenger.toast(AcademicPeopleCopy.assignmentEnded);
}

Future<TeachingRole?> _chooseRole(BuildContext context) {
  return showDialog<TeachingRole>(
    context: context,
    builder: (context) => SimpleDialog(
      title: const Text(AcademicPeopleCopy.chooseRoleTitle),
      children: [
        for (final role in const [
          TeachingRole.teacher,
          TeachingRole.assistantTeacher,
        ])
          SimpleDialogOption(
            onPressed: () => Navigator.of(context).pop(role),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: Insets.sm),
              child: Text(AcademicPeopleCopy.role(role)),
            ),
          ),
      ],
    ),
  );
}
