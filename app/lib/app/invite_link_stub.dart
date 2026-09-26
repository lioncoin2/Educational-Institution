/// iOS, Android and the Dart VM: no address bar to read a link from, and no
/// address of the app's own to write one with. Invitation links are the web
/// app's; anywhere else there is never a token, and never a link.
library;

String? takeInviteToken() => null;

void listenForInviteTokens(void Function(String token) onToken) {}

Uri? inviteLinkFor(String token) => null;
