import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../providers/app_providers.dart';

/// The tasks permissions the signed-in account holds (ADR 0052 §10) — used to
/// show or hide entry points only; the server authorizes every call.
abstract final class TasksPermissions {
  static const respond = 'tasks.respond';
  static const manage = 'tasks.manage';
  static const template = 'tasks.template';
}

final canRespondToTasksProvider = Provider.autoDispose<bool>(
  (ref) => ref.watch(
    sessionUserProvider.select((s) => s.value?.can(TasksPermissions.respond) ?? false),
  ),
);

final canManageTasksProvider = Provider.autoDispose<bool>(
  (ref) => ref.watch(
    sessionUserProvider.select((s) => s.value?.can(TasksPermissions.manage) ?? false),
  ),
);

final canUseTaskTemplatesProvider = Provider.autoDispose<bool>(
  (ref) => ref.watch(
    sessionUserProvider.select((s) => s.value?.can(TasksPermissions.template) ?? false),
  ),
);
