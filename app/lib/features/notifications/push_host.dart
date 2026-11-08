import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../data/push/push_seams.dart';
import '../../providers/app_providers.dart';
import 'notification_copy.dart';
import 'state/push_offer.dart';
import 'state/push_registration.dart';
import 'state/push_taps.dart';
import 'state/unread_count_controller.dart';

/// Wraps the app's routed content (the `MaterialApp.router` builder) in a build
/// with push (ADR 0058). It keeps the device's registration alive, opens what a
/// tapped notification points at — the tap that started the app once someone
/// is signed in, and every later one — re-checks the permission when the app
/// comes back, and shows the app's once-per-installation offer to turn
/// notifications on. In a build without push it adds nothing at all.
///
/// The tree is the same shape with or without the offer (the routed [child]
/// keeps its key), so the offer coming and going never rebuilds the navigator.
class PushHost extends ConsumerStatefulWidget {
  const PushHost({super.key, required this.router, required this.child});

  final GoRouter router;
  final Widget child;

  @override
  ConsumerState<PushHost> createState() => _PushHostState();
}

class _PushHostState extends ConsumerState<PushHost>
    with WidgetsBindingObserver {
  static const _contentKey = ValueKey('push-content');

  StreamSubscription<PushTap>? _taps;
  bool _initialTapSettled = false;

  @override
  void initState() {
    super.initState();
    final source = ref.read(pushTokenSourceProvider);
    if (!source.isAvailable) return;
    WidgetsBinding.instance.addObserver(this);
    _taps = source.taps.listen((tap) => unawaited(_open(tap)));
    // The tap that started the app is opened once someone is signed in — and
    // dropped if nobody is: it was for an account no longer signed in here.
    ref.listenManual(sessionUserProvider, (_, next) {
      if (_initialTapSettled || next.isLoading || next.hasError) return;
      _initialTapSettled = true;
      if (next.value != null) unawaited(_openInitialTap(source));
    }, fireImmediately: true);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_taps?.cancel());
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    final userId = ref.read(sessionUserProvider).value?.id;
    unawaited(ref.read(pushRegistrationProvider).resumed(userId));
    ref.invalidate(pushOfferProvider);
  }

  Future<void> _openInitialTap(PushTokenSource source) async {
    final tap = await source.initialTap();
    if (tap != null && mounted) await _open(tap);
  }

  Future<void> _open(PushTap tap) async {
    final location = await ref.read(pushTapHandlerProvider).locationFor(tap);
    // The host may be gone by now; its ref with it.
    if (!mounted) return;
    unawaited(ref.read(unreadCountProvider.notifier).refresh());
    if (location != null) unawaited(widget.router.push(location));
  }

  @override
  Widget build(BuildContext context) {
    if (!ref.watch(pushTokenSourceProvider).isAvailable) return widget.child;
    ref.watch(pushRegistrationProvider);
    final offer = ref.watch(pushOfferProvider).value == PushOffer.offer;
    return Column(
      children: [
        if (offer) const _PushOfferBar(),
        Expanded(
          key: _contentKey,
          child: MediaQuery.removePadding(
            context: context,
            // The bar already sits under the status bar.
            removeTop: offer,
            child: widget.child,
          ),
        ),
      ],
    );
  }
}

/// The app's own question, before the system's: why, and that a push says
/// nothing but the kind of thing that happened.
class _PushOfferBar extends ConsumerWidget {
  const _PushOfferBar();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = context.colors;
    return Material(
      color: colors.secondaryContainer,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            Insets.lg,
            Insets.md,
            Insets.lg,
            Insets.sm,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.notifications_active_outlined,
                    color: colors.onSecondaryContainer,
                  ),
                  const SizedBox(width: Insets.sm),
                  Expanded(
                    child: Text(
                      NotificationCopy.pushOfferTitle,
                      style: context.text.titleSmall?.copyWith(
                        color: colors.onSecondaryContainer,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: Insets.xs),
              Text(
                NotificationCopy.pushOfferBody,
                style: context.text.bodySmall?.copyWith(
                  color: colors.onSecondaryContainer,
                ),
              ),
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: Wrap(
                  spacing: Insets.sm,
                  children: [
                    TextButton(
                      onPressed: () => unawaited(
                        ref.read(pushOfferProvider.notifier).later(),
                      ),
                      child: const Text(NotificationCopy.pushLater),
                    ),
                    FilledButton(
                      onPressed: () => unawaited(
                        ref.read(pushOfferProvider.notifier).enable(),
                      ),
                      child: const Text(NotificationCopy.pushEnable),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
