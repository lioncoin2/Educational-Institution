import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/routes.dart';
import '../../data/models/communities.dart';
import '../../data/models/live.dart';
import '../../data/models/messaging.dart';
import '../../data/models/notifications.dart';
import '../../data/models/tasks/tasks.dart';
import '../../data/repositories/repositories.dart';
import '../../providers/app_providers.dart';
import '../../providers/tasks_providers.dart';
import 'notification_copy.dart';

/// Where tapping a notification goes.
sealed class TargetResolution {
  const TargetResolution();
}

/// Open this route: the destination was just confirmed available.
final class OpenRoute extends TargetResolution {
  const OpenRoute(this.location);

  final String location;
}

/// Nowhere — say [message] instead.
final class CannotOpen extends TargetResolution {
  const CannotOpen(this.message);

  final String message;
}

/// Turns a notification's target into a destination — by asking the module
/// that owns it, through its ordinary API, whether the signed-in person may
/// open it NOW. A notification grants nothing: someone removed from a
/// conversation gets "no longer available" from messaging exactly as if
/// they had typed its address, and the conversation screen would refuse
/// them the same way.
class NotificationTargetResolver {
  const NotificationTargetResolver(
    this._messaging,
    this._taskAdministration,
    this._myTasks,
    this._communities,
    this._live,
  );

  final MessagingRepository _messaging;
  final TaskAdministrationRepository _taskAdministration;
  final MyTasksRepository _myTasks;
  final CommunityRepository _communities;
  final LiveRepository _live;

  Future<TargetResolution> resolve(NotificationTarget target) async {
    switch (target) {
      case ConversationTarget(:final conversationId):
        try {
          await _messaging.conversation(conversationId);
        } on MessagingException catch (error) {
          return CannotOpen(
            error.code == 'messaging.conversation_not_found'
                ? NotificationCopy.contentGone
                : NotificationCopy.error(error.code),
          );
        }
        return OpenRoute(Routes.conversation(conversationId));
      case TaskTarget(:final taskId):
        try {
          await _taskAdministration.task(taskId);
        } on TasksException catch (error) {
          return CannotOpen(_taskRefusal(error));
        }
        return OpenRoute(Routes.task(taskId));
      case AssignedTaskTarget(:final taskId):
        // The notification names the task; the page is the person's own
        // assignment of it — which may have been reassigned since.
        final MyTaskDetail mine;
        try {
          mine = await _myTasks.myTaskByTask(taskId);
        } on TasksException catch (error) {
          return CannotOpen(_taskRefusal(error));
        }
        return OpenRoute(Routes.myTask(mine.assignment.id));
      case CommunityTarget(:final communityId):
        try {
          await _communities.community(communityId);
        } on CommunityException catch (error) {
          return CannotOpen(
            error.isGone ? NotificationCopy.contentGone : NotificationCopy.error(error.code),
          );
        }
        return OpenRoute(Routes.community(communityId));
      case LiveRoomTarget(:final liveSessionId):
        // The notification names the session; the room is its community's.
        final LiveSession session;
        try {
          session = await _live.getSession(liveSessionId);
        } on LiveException catch (error) {
          return CannotOpen(
            error.isGone ? NotificationCopy.contentGone : NotificationCopy.error(error.code),
          );
        }
        return session.state == LiveSessionState.live
            ? OpenRoute(Routes.communityLive(session.communityId))
            : const CannotOpen(NotificationCopy.liveEnded);
      case UnsupportedTarget():
        return const CannotOpen(NotificationCopy.unsupported);
    }
  }

  static String _taskRefusal(TasksException error) => switch (error.code) {
    'tasks.task_not_found' || 'tasks.assignment_not_found' => NotificationCopy.contentGone,
    _ => NotificationCopy.error(error.code),
  };
}

final notificationTargetResolverProvider = Provider<NotificationTargetResolver>(
  (ref) => NotificationTargetResolver(
    ref.watch(messagingRepositoryProvider),
    ref.watch(taskAdministrationRepositoryProvider),
    ref.watch(myTasksRepositoryProvider),
    ref.watch(communityRepositoryProvider),
    ref.watch(liveRepositoryProvider),
  ),
);
