import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../data/push/push_seams.dart';
import '../../../providers/app_providers.dart';
import 'push_registration.dart';

/// What the app may say about push on this device now (ADR 0058).
enum PushOffer {
  /// Nothing: no push in this build, nobody signed in, or it is on already.
  none,

  /// The app's own question, once per installation, before the system's.
  offer,

  /// Off, and the system would still ask: the notifications screen offers it.
  canEnable,

  /// Off for good: only the system settings can turn it on.
  blocked,
}

/// Decides [PushOffer] and acts on the person's answer. The system's dialog is
/// only ever shown because the person tapped "turn on", never on its own.
///
/// The dialog pauses the app, and coming back may rebuild this controller
/// (`PushHost` re-checks on resume): everything an answer needs is read before
/// the first await, and nothing of this controller is touched after one unless
/// it is still mounted.
class PushOfferController extends AsyncNotifier<PushOffer> {
  @override
  Future<PushOffer> build() async {
    final userId = ref.watch(
      sessionUserProvider.select((session) => session.value?.id),
    );
    final source = ref.watch(pushTokenSourceProvider);
    if (userId == null || !source.isAvailable) return PushOffer.none;
    return _offerFor(source, await source.permission());
  }

  static Future<PushOffer> _offerFor(
    PushTokenSource source,
    PushPermission permission,
  ) async => switch (permission) {
    PushPermission.granted || PushPermission.unsupported => PushOffer.none,
    PushPermission.notDetermined =>
      await source.wasOffered() ? PushOffer.canEnable : PushOffer.offer,
    PushPermission.denied => PushOffer.canEnable,
    PushPermission.deniedPermanently => PushOffer.blocked,
  };

  /// Yes: the system's question — and if allowed, this device registers.
  Future<void> enable() async {
    final source = ref.read(pushTokenSourceProvider);
    final registration = ref.read(pushRegistrationProvider);
    final userId = ref.read(sessionUserProvider).value?.id;
    final before = await source.permission();
    await source.markOffered();
    final after = await source.requestPermission();
    if (after == PushPermission.granted && userId != null) {
      await registration.register(userId);
    }
    // Refused again without the system asking — Android 12 and older never
    // ask, and a turned-off app stays off — so only the settings can help.
    final effective =
        before == PushPermission.denied && after == PushPermission.denied
        ? PushPermission.deniedPermanently
        : after;
    final next = await _offerFor(source, effective);
    if (ref.mounted) state = AsyncData(next);
  }

  /// Not now: the offer is not made again; the notifications screen keeps a
  /// way to turn push on.
  Future<void> later() async {
    final source = ref.read(pushTokenSourceProvider);
    await source.markOffered();
    final next = await _offerFor(source, await source.permission());
    if (ref.mounted) state = AsyncData(next);
  }
}

final pushOfferProvider = AsyncNotifierProvider<PushOfferController, PushOffer>(
  PushOfferController.new,
);
