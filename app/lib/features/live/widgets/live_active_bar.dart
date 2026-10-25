import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/live_media.dart';
import '../live_copy.dart';
import '../state/live_media_controller.dart';

/// Wraps the app's routed content (the `MaterialApp.router` builder). While this
/// device is still in a live room — navigating away does not leave it — every
/// OTHER screen carries a slim bar on top saying so, with the microphone's real
/// state, a way back to the room and an explicit leave (Telegram-style). On the
/// live room itself, and when no room is live, nothing is added.
///
/// The tree is the same shape with or without the bar (the routed [child] keeps
/// its key and wrapper), so the bar coming and going never rebuilds the
/// navigator or loses a screen's state.
class LiveActiveBarHost extends ConsumerWidget {
  const LiveActiveBarHost({
    super.key,
    required this.router,
    required this.child,
  });

  final GoRouter router;
  final Widget child;

  static const _contentKey = ValueKey('app-content');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final active = ref.watch(liveActiveSessionProvider);
    return _RouterPath(
      router: router,
      builder: (context, here) {
        final show =
            active != null && here != Routes.communityLive(active.communityId);
        return Column(
          children: [
            if (show) _LiveActiveBar(active: active, router: router),
            Expanded(
              key: _contentKey,
              child: MediaQuery.removePadding(
                context: context,
                // The bar already sits under the status bar.
                removeTop: show,
                child: child,
              ),
            ),
          ],
        );
      },
    );
  }
}

/// The router's current path, rebuilt when it changes. The host sits ABOVE the
/// router, and the router reports its first location while it is itself being
/// built, so a change that lands mid-build is applied right after the frame
/// instead of marking an ancestor dirty during the build.
class _RouterPath extends StatefulWidget {
  const _RouterPath({required this.router, required this.builder});

  final GoRouter router;
  final Widget Function(BuildContext context, String path) builder;

  @override
  State<_RouterPath> createState() => _RouterPathState();
}

class _RouterPathState extends State<_RouterPath> {
  late String _path = _read();

  @override
  void initState() {
    super.initState();
    widget.router.routerDelegate.addListener(_changed);
  }

  @override
  void dispose() {
    widget.router.routerDelegate.removeListener(_changed);
    super.dispose();
  }

  /// The TOPMOST route's path — a pushed screen included (the configuration's
  /// own uri names only the base location under the pushes).
  String _read() =>
      widget.router.routerDelegate.currentConfiguration.isEmpty
      ? ''
      : widget.router.state.uri.path;

  void _changed() {
    if (_read() == _path) return;
    final scheduler = SchedulerBinding.instance;
    if (scheduler.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      scheduler.addPostFrameCallback((_) {
        if (mounted) setState(() => _path = _read());
      });
    } else {
      setState(() => _path = _read());
    }
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, _path);
}

class _LiveActiveBar extends ConsumerWidget {
  const _LiveActiveBar({required this.active, required this.router});

  final LiveActiveSession active;
  final GoRouter router;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    final state = ref.watch(liveMediaProvider(active.sessionId));
    final micOn =
        ref.watch(liveMediaPublicationProvider).value?.microphoneOn ?? false;
    final reconnecting = state is LiveMediaReconnecting;
    final title = reconnecting
        ? LiveCopy.activeBarReconnecting
        : micOn
        ? '${LiveCopy.activeBarTitle} · ${LiveCopy.activeBarMicOn}'
        : LiveCopy.activeBarTitle;

    return Material(
      key: const Key('live-active-bar'),
      color: colors.primaryContainer,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: Insets.md,
            vertical: Insets.xs,
          ),
          child: Row(
            children: [
              Icon(
                micOn ? Icons.mic_rounded : Icons.graphic_eq_rounded,
                color: micOn ? colors.error : colors.onPrimaryContainer,
                size: 20,
              ),
              const SizedBox(width: Insets.sm),
              Expanded(
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.labelLarge?.copyWith(
                    color: colors.onPrimaryContainer,
                  ),
                ),
              ),
              TextButton(
                key: const Key('live-active-return'),
                onPressed: () =>
                    router.push(Routes.communityLive(active.communityId)),
                child: const Text(LiveCopy.activeBarReturn),
              ),
              TextButton(
                key: const Key('live-active-leave'),
                onPressed: () => ref
                    .read(liveMediaProvider(active.sessionId).notifier)
                    .disconnect(),
                child: const Text(LiveCopy.activeBarLeave),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
