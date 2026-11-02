import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../data/models/tasks/tasks.dart';
import 'admin/task_composer_screen.dart';
import 'admin/task_detail_screen.dart';
import 'admin/task_templates_screen.dart';
import 'admin/tasks_admin_screen.dart';
import 'insights/task_dashboard_screen.dart';
import 'recipient/my_task_screen.dart';
import 'recipient/my_tasks_screen.dart';
import 'reports/task_report_screen.dart';
import 'reports/task_reports_screen.dart';

/// The daily tasks & reports engine's routes (ADR 0052), full-screen above the
/// tab bar on the [root] navigator. The router includes them as one list, so
/// the feature's screens are wired in one place.
List<RouteBase> tasksRoutes(GlobalKey<NavigatorState> root) => [
  GoRoute(
    path: Routes.myTasks,
    name: 'my-tasks',
    parentNavigatorKey: root,
    builder: (context, state) => const MyTasksScreen(),
    routes: [
      GoRoute(
        path: ':assignmentId',
        name: 'my-task',
        parentNavigatorKey: root,
        builder: (context, state) =>
            MyTaskScreen(assignmentId: state.pathParameters['assignmentId']!),
      ),
    ],
  ),
  GoRoute(
    path: Routes.tasksAdmin,
    name: 'tasks-admin',
    parentNavigatorKey: root,
    builder: (context, state) => const TasksAdminScreen(),
    routes: [
      // Before ':taskId', so "new" is never read as a task id.
      GoRoute(
        path: 'new',
        name: 'task-compose',
        parentNavigatorKey: root,
        builder: (context, state) => TaskComposerScreen(
          mode: ComposerMode.create,
          template: state.extra is TaskTemplate ? state.extra! as TaskTemplate : null,
        ),
      ),
      GoRoute(
        path: ':taskId',
        name: 'task',
        parentNavigatorKey: root,
        builder: (context, state) => TaskDetailScreen(taskId: state.pathParameters['taskId']!),
        routes: [
          GoRoute(
            path: 'edit',
            name: 'task-edit',
            parentNavigatorKey: root,
            builder: (context, state) => TaskComposerScreen(
              mode: ComposerMode.edit,
              taskId: state.pathParameters['taskId'],
            ),
          ),
          GoRoute(
            path: 'republish',
            name: 'task-republish',
            parentNavigatorKey: root,
            builder: (context, state) => TaskComposerScreen(
              mode: ComposerMode.republish,
              taskId: state.pathParameters['taskId'],
            ),
          ),
        ],
      ),
    ],
  ),
  GoRoute(
    path: Routes.taskReports,
    name: 'task-reports',
    parentNavigatorKey: root,
    builder: (context, state) => const TaskReportsScreen(),
    routes: [
      GoRoute(
        path: ':reportId',
        name: 'task-report',
        parentNavigatorKey: root,
        builder: (context, state) => TaskReportScreen(reportId: state.pathParameters['reportId']!),
      ),
    ],
  ),
  GoRoute(
    path: Routes.taskDashboard,
    name: 'task-dashboard',
    parentNavigatorKey: root,
    builder: (context, state) => const TaskDashboardScreen(),
  ),
  GoRoute(
    path: Routes.taskTemplates,
    name: 'task-templates',
    parentNavigatorKey: root,
    builder: (context, state) => const TaskTemplatesScreen(),
  ),
];
