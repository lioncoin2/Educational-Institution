import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/models/live_room.dart';
import '../../../data/realtime/realtime_frames.dart';
import '../../../providers/app_providers.dart';

/// One reaction on screen: it floats up over the stage, then is gone.
/// [mine] is the viewer's own tap, drawn at once; everyone else's arrives as a
/// `live.reaction` frame that names nobody.
class LiveReactionBurst {
  const LiveReactionBurst({
    required this.id,
    required this.kind,
    required this.mine,
  });

  final String id;
  final LiveReactionKind kind;
  final bool mine;
}

/// The live room's reactions for ONE session (ADR 0049) — an ephemeral,
/// on-screen list of bursts; nothing is stored or counted, here or on the
/// server.
///
/// Sending: the viewer's tap is drawn at once (the server never echoes it to
/// the sender's devices), then sent; a refusal surfaces to the caller with the
/// server's code. A short cooldown keeps a held finger from flooding the server
/// below its own per-minute limit. Receiving: a frame for THIS session only,
/// deduplicated by its event id, so a redelivery or a reconnect replay shows
/// once. A reconnect needs no catch-up — a reaction that was missed is gone,
/// which is the point of an ephemeral gesture — and nothing outlives the
/// session: the ended room disposes the list.
class LiveReactionsController extends Notifier<List<LiveReactionBurst>> {
  LiveReactionsController(this.sessionId);

  final String sessionId;

  /// How long a burst stays on screen.
  static const shown = Duration(milliseconds: 2400);

  /// At most this many on screen at once; the oldest goes first.
  static const maxShown = 16;

  /// The least time between two of the viewer's own sends.
  static const cooldown = Duration(milliseconds: 300);

  /// Frame ids already shown — bounded, oldest forgotten first.
  static const _remember = 256;

  final _seen = <String>{}; // a LinkedHashSet: insertion-ordered
  final _timers = <Timer>{};
  Timer? _cooling;
  int _local = 0;

  @override
  List<LiveReactionBurst> build() {
    final realtime = ref.watch(realtimeConnectionProvider);
    final events = realtime.events.listen((event) {
      if (event is LiveReactionEvent && event.sessionId == sessionId) {
        _receive(event);
      }
    });
    ref.onDispose(() {
      unawaited(events.cancel());
      for (final timer in _timers) {
        timer.cancel();
      }
      _timers.clear();
      _cooling?.cancel();
    });
    return const [];
  }

  /// Whether a tap now would be sent (false during the short cooldown).
  bool get canSend => _cooling == null;

  /// Draws the viewer's reaction and sends it. A tap inside the cooldown is
  /// dropped (nothing drawn, nothing sent). Throws the repository's
  /// `LiveException` on a refusal — the burst already shown simply floats away.
  Future<void> send(LiveReactionKind kind) async {
    if (_cooling != null) return;
    _cooling = Timer(cooldown, () => _cooling = null);
    _show(LiveReactionBurst(id: 'mine:${_local++}', kind: kind, mine: true));
    await ref.read(liveRoomRepositoryProvider).react(sessionId, kind);
  }

  void _receive(LiveReactionEvent event) {
    if (!_seen.add(event.eventId)) return; // a redelivery: already shown
    if (_seen.length > _remember) _seen.remove(_seen.first);
    _show(LiveReactionBurst(id: event.eventId, kind: event.kind, mine: false));
  }

  void _show(LiveReactionBurst burst) {
    final kept = state.length >= maxShown
        ? state.sublist(state.length - maxShown + 1)
        : state;
    state = [...kept, burst];
    late final Timer timer;
    timer = Timer(shown, () {
      _timers.remove(timer);
      if (!ref.mounted) return;
      state = [
        for (final b in state)
          if (b.id != burst.id) b,
      ];
    });
    _timers.add(timer);
  }
}

final liveReactionsProvider = NotifierProvider.autoDispose
    .family<LiveReactionsController, List<LiveReactionBurst>, String>(
      LiveReactionsController.new,
    );
