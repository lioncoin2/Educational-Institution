import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/routes.dart';
import '../../../data/models/messaging.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';
import '../messaging_copy.dart';

/// What "start a direct conversation with this person" resolves to.
sealed class DmStart {
  const DmStart();
}

/// Open this route: the server started — or returned — the conversation.
final class OpenConversation extends DmStart {
  const OpenConversation(this.location);

  final String location;
}

/// Nowhere — say [message] instead. The server refused (a counterpart the
/// viewer may not reach, reported like an unknown account — Q6), or answered
/// with something that is not a conversation.
final class CannotStartDm extends DmStart {
  const CannotStartDm(this.message);

  final String message;
}

/// Starts a direct conversation by asking the server, which decides who the
/// viewer may reach (`messaging.start_direct` for staff, `start_direct_peer`
/// for a student → another student). The affordance the UI showed grants
/// nothing: a student who taps a teacher's name is refused here, exactly as if
/// they had addressed any account they may not. Idempotent on the server, so a
/// double-tap never makes two conversations. Once resolved, the conversation
/// is opened by its own id, like any other.
class DirectMessageStarter {
  const DirectMessageStarter(this._messaging);

  final MessagingRepository _messaging;

  Future<DmStart> start(String userId) async {
    final Conversation conversation;
    try {
      conversation = await _messaging.startDirect(userId);
    } on MessagingException catch (error) {
      return CannotStartDm(MessagingCopy.dmUnavailable(error.code));
    } on FormatException {
      return CannotStartDm(MessagingCopy.dmUnavailable(null));
    } on TypeError {
      return CannotStartDm(MessagingCopy.dmUnavailable(null));
    }
    return OpenConversation(Routes.conversation(conversation.id));
  }
}

final directMessageStarterProvider = Provider<DirectMessageStarter>(
  (ref) => DirectMessageStarter(ref.watch(messagingRepositoryProvider)),
);
