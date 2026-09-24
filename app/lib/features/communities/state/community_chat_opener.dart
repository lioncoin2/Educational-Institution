import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/routes.dart';
import '../../../data/models/messaging.dart';
import '../../../data/repositories/repositories.dart';
import '../../../providers/app_providers.dart';
import '../community_copy.dart';

/// Where "open the community's chat" goes.
sealed class ChatOpening {
  const ChatOpening();
}

/// Open this route: the chat was just confirmed readable.
final class OpenChat extends ChatOpening {
  const OpenChat(this.location);

  final String location;
}

/// Nowhere — say [message] instead.
final class CannotOpenChat extends ChatOpening {
  const CannotOpenChat(this.message);

  final String message;
}

/// Opens a community's chat by asking messaging for it — which asks the
/// community whether the viewer may read it NOW. A button the community
/// screen showed grants nothing: someone removed meanwhile is told the chat
/// is not theirs, exactly as if they had typed its address. Once resolved,
/// the chat is an ordinary conversation, opened by its own id.
class CommunityChatOpener {
  const CommunityChatOpener(this._messaging);

  final MessagingRepository _messaging;

  Future<ChatOpening> open(String communityId) async {
    final Conversation chat;
    try {
      chat = await _messaging.conversationForCommunity(communityId);
    } on MessagingException catch (error) {
      return CannotOpenChat(CommunityCopy.chatUnavailable(error.code));
    } on FormatException {
      // An answer that is not a conversation opens nothing — and must not
      // leave the button spinning either.
      return CannotOpenChat(CommunityCopy.chatUnavailable(null));
    } on TypeError {
      return CannotOpenChat(CommunityCopy.chatUnavailable(null));
    }
    return OpenChat(Routes.conversation(chat.id));
  }
}

final communityChatOpenerProvider = Provider<CommunityChatOpener>(
  (ref) => CommunityChatOpener(ref.watch(messagingRepositoryProvider)),
);
