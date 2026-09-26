import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../providers/app_providers.dart';

/// Whether a per-person community frame is about the person signed in on
/// this device.
///
/// The server addresses `community.member.*` frames to their subject alone,
/// so one naming somebody else is not this screen's business. While nobody
/// is known — the demo, or a session still resolving — the server's
/// addressing is taken at its word: acting on the frame only means asking
/// the server again. Only the account's id is read, never its roles or
/// permissions: what the viewer may do is the community's answer.
bool concernsViewer(Ref ref, String userId) {
  final viewer = ref.read(sessionUserProvider).value?.id;
  return viewer == null || viewer == userId;
}

/// The id of the account signed in on this device — or null while none is
/// known (the demo before a sign-in, a session still resolving).
///
/// For the one comparison the community screens make with an account id:
/// telling the viewer's own roster row, or own link, from anyone else's. It
/// is compared, never shown. While nobody is known nothing is taken to be
/// the viewer's — so what must never be offered on the viewer's own row is
/// offered on no row, and no link is called theirs.
final communityViewerIdProvider = Provider<String?>(
  (ref) =>
      ref.watch(sessionUserProvider.select((session) => session.value?.id)),
);
