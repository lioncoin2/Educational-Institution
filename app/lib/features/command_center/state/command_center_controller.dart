import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/command_center.dart';
import '../../../providers/app_providers.dart';

/// The Owner Command Center (`GET /reporting/command-center`), read-only.
///
/// The server resolves the widgets the viewer may see and their current facts;
/// this controller only reads them. A different signed-in viewer is a different
/// answer, so it re-reads on account change. A refused read surfaces as an error
/// state (handled by the screen), never fabricated or empty data — an empty set
/// is a legitimate answer the server itself returned.
class CommandCenterController extends AsyncNotifier<CommandCenter> {
  @override
  Future<CommandCenter> build() async {
    ref.watch(sessionUserProvider.select((session) => session.value?.id));
    return ref.read(reportingRepositoryProvider).commandCenter();
  }

  /// Re-reads the command center. A failure surfaces to the screen's retry.
  Future<void> refresh() {
    ref.invalidateSelf();
    return future.then<void>((_) {}, onError: (Object _) {});
  }
}

final commandCenterProvider =
    AsyncNotifierProvider.autoDispose<CommandCenterController, CommandCenter>(
      CommandCenterController.new,
      retry: (_, _) => null,
    );
