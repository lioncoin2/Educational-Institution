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
