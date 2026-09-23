import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/routes.dart';
import '../../data/models/messaging.dart';
import '../../data/models/notifications.dart';
import '../../data/repositories/repositories.dart';
import '../../providers/app_providers.dart';
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
  const NotificationTargetResolver(this._messaging);

  final MessagingRepository _messaging;

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
      case UnsupportedTarget():
        return const CannotOpen(NotificationCopy.unsupported);
    }
  }
}

final notificationTargetResolverProvider = Provider<NotificationTargetResolver>(
  (ref) => NotificationTargetResolver(ref.watch(messagingRepositoryProvider)),
);
