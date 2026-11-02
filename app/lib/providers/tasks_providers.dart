import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/repositories/contracts/tasks_repositories.dart';
import '../data/repositories/http/tasks/http_my_tasks_repository.dart';
import '../data/repositories/http/tasks/http_task_administration_repository.dart';
import '../data/repositories/http/tasks/http_task_insights_repository.dart';
import '../data/repositories/http/tasks/http_task_reports_repository.dart';
import '../data/repositories/mock/tasks/demo_tasks_repositories.dart';
import 'app_providers.dart';

/// Composition of the daily tasks & reports engine (ADR 0052): the HTTP
/// repositories against the backend, the honest "needs the server" stand-ins
/// in the demo. Kept beside — not inside — `app_providers.dart`.

final Provider<MyTasksRepository> myTasksRepositoryProvider = Provider<MyTasksRepository>(
  (ref) => ref.watch(backendModeProvider)
      ? HttpMyTasksRepository(ref.watch(apiClientProvider))
      : const DemoMyTasksRepository(),
);

final Provider<TaskAdministrationRepository> taskAdministrationRepositoryProvider =
    Provider<TaskAdministrationRepository>(
      (ref) => ref.watch(backendModeProvider)
          ? HttpTaskAdministrationRepository(ref.watch(apiClientProvider))
          : const DemoTaskAdministrationRepository(),
    );

final Provider<TaskReportsRepository> taskReportsRepositoryProvider =
    Provider<TaskReportsRepository>(
      (ref) => ref.watch(backendModeProvider)
          ? HttpTaskReportsRepository(ref.watch(apiClientProvider))
          : const DemoTaskReportsRepository(),
    );

final Provider<TaskInsightsRepository> taskInsightsRepositoryProvider =
    Provider<TaskInsightsRepository>(
      (ref) => ref.watch(backendModeProvider)
          ? HttpTaskInsightsRepository(ref.watch(apiClientProvider))
          : const DemoTaskInsightsRepository(),
    );
