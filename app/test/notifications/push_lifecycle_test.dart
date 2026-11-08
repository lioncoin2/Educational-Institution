import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/app/routes.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/notifications.dart';
import 'package:quran_institution_app/data/push/push_seams.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/notifications/notification_target_resolver.dart';
import 'package:quran_institution_app/features/notifications/state/push_offer.dart';
import 'package:quran_institution_app/features/notifications/state/push_registration.dart';
import 'package:quran_institution_app/features/notifications/state/push_taps.dart';
import 'package:quran_institution_app/features/profile/state/sign_out.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

import 'notification_test_support.dart';

const _ali = CurrentUser(
  id: 'u-ali',
  displayName: 'علي',
  status: AccountStatus.active,
  roles: ['STUDENT'],
  permissions: {'messaging.read'},
);

const _sara = CurrentUser(
  id: 'u-sara',
  displayName: 'سارة',
  status: AccountStatus.active,
  roles: ['STUDENT'],
  permissions: {'messaging.read'},
);

/// Who is signed in, settable; signing out is recorded in the shared [log].
class _Auth implements AuthRepository {
  _Auth(this.log, [this.user]);

  final List<String> log;
  CurrentUser? user;

  @override
  Future<CurrentUser?> currentUser() async => user;

  @override
  Future<void> signOut() async {
    log.add('signOut');
    user = null;
  }

  @override
  Future<CurrentUser> signIn({
    required String identifier,
    required String password,
  }) => throw UnimplementedError();

  @override
  Future<List<DeviceSession>> sessions() => throw UnimplementedError();

  @override
  Future<void> endSession(String sessionId) => throw UnimplementedError();

  @override
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) => throw UnimplementedError();
}

/// The inbox server, with device calls recorded in the shared [log].
class _Notifications extends ScriptedNotifications {
  _Notifications(this.log);

  final List<String> log;

  @override
  Future<RegisteredDevice> registerDevice({
    required String platform,
    required String provider,
    required String token,
  }) {
    log.add('register $token');
    return super.registerDevice(
      platform: platform,
      provider: provider,
      token: token,
    );
  }

  @override
  Future<void> unregisterDevice(String deviceId) {
    log.add('unregister');
    return super.unregisterDevice(deviceId);
  }
}

void main() {
  late List<String> log;
  late FakePushTokenSource source;
  late _Auth auth;
  late _Notifications repo;
  late ProviderContainer container;

  Future<void> settle() async {
    for (var i = 0; i < 10; i++) {
      await Future<void>.delayed(Duration.zero);
    }
  }

  Future<PushRegistration> start({
    CurrentUser? signedIn,
    PushTokenSource? push,
  }) async {
    auth = _Auth(log, signedIn);
    container = ProviderContainer(
      overrides: [
        authRepositoryProvider.overrideWithValue(auth),
        notificationsRepositoryProvider.overrideWithValue(repo),
        pushTokenSourceProvider.overrideWithValue(push ?? source),
      ],
    );
    addTearDown(container.dispose);
    await container.read(sessionUserProvider.future);
    final registration = container.read(pushRegistrationProvider);
    await settle();
    return registration;
  }

  /// The session reads [user] now — a sign-in, or the server ending it.
  Future<void> sessionBecomes(CurrentUser? user) async {
    auth.user = user;
    container.invalidate(sessionUserProvider);
    await container.read(sessionUserProvider.future);
    await settle();
  }

  setUp(() {
    log = [];
    source = FakePushTokenSource(log);
    repo = _Notifications(log);
  });

  group('registration follows the session (ADR 0058)', () {
    test(
      'registers when someone is signed in and allows notifications',
      () async {
        final registration = await start(signedIn: _ali);
        expect(log, ['register fcm-test-token']);
        expect(registration.deviceId, isNotNull);
      },
    );

    test('registers nothing while notifications are not allowed — and never asks by itself', () async {
      for (final permission in [
        PushPermission.notDetermined,
        PushPermission.denied,
        PushPermission.deniedPermanently,
      ]) {
        log.clear();
        source = FakePushTokenSource(log)..permissionNow = permission;
        await start(signedIn: _ali);
        expect(
          log,
          isNot(contains('register fcm-test-token')),
          reason: '$permission',
        );
        expect(source.requests, 0);
      }
    });

    test('registers a rotated token once, and the same token for the same account never twice', () async {
      await start(signedIn: _ali);
      source.rotate('fcm-rotated');
      await settle();
      source.rotate('fcm-rotated');
      await settle();
      await sessionBecomes(_ali); // the session re-read, same account
      expect(log, ['register fcm-test-token', 'register fcm-rotated']);
    });

    test('an explicit sign-out releases the device first, then signs out, then deletes the token', () async {
      await start(signedIn: _ali);
      log.clear();
      await container.read(signOutProvider)();
      await container.read(sessionUserProvider.future);
      await settle();
      expect(log, ['unregister', 'signOut', 'disable']);
    });

    test(
      'signing out never waits long for the server to forget the device',
      () async {
        repo = _Hanging(log);
        await start(signedIn: _ali);
        log.clear();
        final watch = Stopwatch()..start();
        await container.read(signOutProvider)();
        expect(watch.elapsed, lessThan(const Duration(seconds: 6)));
        expect(log.take(2), ['unregister', 'signOut']);
      },
      timeout: const Timeout(Duration(seconds: 20)),
    );

    test('a session the server ended deletes the token here too — nothing left to release', () async {
      await start(signedIn: _ali);
      log.clear();
      await sessionBecomes(null);
      expect(log, ['disable']);
    });

    test('one thing at a time: a token is not fetched while the last one is being deleted', () async {
      final registration = await start(signedIn: _ali);
      log.clear();
      source.disableGate = Completer<void>();
      final deleting = registration.disable();
      final registering = registration.register(_sara.id);
      await settle();
      expect(log, isEmpty); // the registration waits for the deletion
      source.tokenValue = 'fcm-new';
      source.disableGate!.complete();
      await Future.wait([deleting, registering]);
      expect(log, ['disable', 'register fcm-new']);
    });

    test(
      'a build that cannot start Firebase registers nothing and offers nothing',
      () async {
        source.permissionNow = PushPermission.unsupported;
        await start(signedIn: _ali);
        expect(log, isNot(contains('register fcm-test-token')));
        expect(await container.read(pushOfferProvider.future), PushOffer.none);
      },
    );

    test(
      'the next person to sign in registers a new token as theirs',
      () async {
        await start(signedIn: _ali);
        await container.read(signOutProvider)();
        source.tokenValue = 'fcm-after-delete';
        await sessionBecomes(_sara);
        expect(log.last, 'register fcm-after-delete');
      },
    );

    test('coming back re-checks: switched off in the settings releases and deletes the token, switched on registers', () async {
      final registration = await start(signedIn: _ali);
      source.permissionNow = PushPermission.deniedPermanently;
      await registration.resumed(_ali.id);
      expect(log.sublist(log.length - 2), ['unregister', 'disable']);
      expect(registration.deviceId, isNull);

      source.permissionNow = PushPermission.granted;
      await registration.resumed(_ali.id);
      expect(log.last, 'register fcm-test-token');
    });
  });

  group('the offer to turn notifications on', () {
    Future<PushOffer> offer() => container.read(pushOfferProvider.future);

    test(
      'is made once, to someone signed in, before the system is asked anything',
      () async {
        source.permissionNow = PushPermission.notDetermined;
        await start(signedIn: _ali);
        expect(await offer(), PushOffer.offer);
        expect(source.requests, 0);

        await container.read(pushOfferProvider.notifier).later();
        expect(source.offered, isTrue);
        expect(await offer(), PushOffer.canEnable);
        expect(source.requests, 0);
      },
    );

    test(
      'turning it on asks the system — and an allowed device registers at once',
      () async {
        source.permissionNow = PushPermission.notDetermined;
        await start(signedIn: _ali);
        await container.read(pushOfferProvider.notifier).enable();
        expect(source.requests, 1);
        expect(await offer(), PushOffer.none);
        expect(log.last, 'register fcm-test-token');
      },
    );

    test('says where to turn it on when the system does not ask — Android 12 and older', () async {
      source
        ..permissionNow = PushPermission.denied
        ..answer = PushPermission.denied; // asked, and nothing changed
      await start(signedIn: _ali);
      expect(await offer(), PushOffer.canEnable);
      await container.read(pushOfferProvider.notifier).enable();
      expect(await offer(), PushOffer.blocked);
    });

    test(
      'says where to turn it on once the system would not ask again',
      () async {
        source
          ..permissionNow = PushPermission.denied
          ..answer = PushPermission.deniedPermanently;
        await start(signedIn: _ali);
        expect(await offer(), PushOffer.canEnable);
        await container.read(pushOfferProvider.notifier).enable();
        expect(await offer(), PushOffer.blocked);
      },
    );

    test('offers nothing to nobody, or in a build without push', () async {
      source.permissionNow = PushPermission.notDetermined;
      await start();
      expect(await offer(), PushOffer.none);
      container.dispose();

      await start(signedIn: _ali, push: const UnavailablePushTokenSource());
      expect(await offer(), PushOffer.none);
    });
  });

  group('a tap on a push notification', () {
    late _Resolver resolver;
    late PushTapHandler handler;

    setUp(() {
      resolver = _Resolver();
      handler = PushTapHandler(repo, resolver);
    });

    test('marks it read, then opens what the owning module confirms', () async {
      repo.deliver(note('n-1', conversationId: 'c-1'));
      resolver.answer = const OpenRoute('/messages/c-1');
      expect(
        await handler.locationFor(
          const PushTap(
            notificationId: 'n-1',
            target: ConversationTarget('c-1'),
          ),
        ),
        '/messages/c-1',
      );
      expect(repo.all.single.isRead, isTrue);
      expect(resolver.asked, [const ConversationTarget('c-1')]);
    });

    test('opens nothing for the same tap twice', () async {
      repo.deliver(note('n-1', conversationId: 'c-1'));
      const tap = PushTap(
        notificationId: 'n-1',
        target: ConversationTarget('c-1'),
      );
      expect(await handler.locationFor(tap), isNotNull);
      expect(await handler.locationFor(tap), isNull);
    });

    test(
      'opens the inbox for a notification that is not this account’s',
      () async {
        repo.failMarkRead = 'notifications.notification_not_found';
        expect(
          await handler.locationFor(
            const PushTap(
              notificationId: 'someone-elses',
              target: ConversationTarget('c-1'),
            ),
          ),
          Routes.notifications,
        );
        expect(resolver.asked, isEmpty);
      },
    );

    test('opens the inbox for what cannot be opened', () async {
      resolver.answer = const CannotOpen('gone');
      expect(
        await handler.locationFor(
          const PushTap(
            notificationId: null,
            target: UnsupportedTarget('certificate'),
          ),
        ),
        Routes.notifications,
      );
    });
  });

  group('what a push carries', () {
    test('reads ids and a typed target from the data payload', () {
      final tap = PushTap.fromData({
        'notificationId': 'n-1',
        'type': 'MESSAGE_RECEIVED',
        'target': '{"kind":"conversation","conversationId":"c-1"}',
      });
      expect(tap.notificationId, 'n-1');
      expect(tap.target, const ConversationTarget('c-1'));
      expect(
        PushTap.fromData({
          'target': '{"kind":"live_room","liveSessionId":"s-1"}',
        }).target,
        const LiveRoomTarget('s-1'),
      );
      expect(
        PushTap.fromData({'target': '{"kind":"community","communityId":"k-1"}'})
            .target,
        const CommunityTarget('k-1'),
      );
    });

    test(
      'turns anything malformed into an unsupported target — never an error',
      () {
        for (final data in <Map<String, Object?>>[
          {},
          {'target': 'not json'},
          {'target': '{"kind":"conversation","conversationId":"../admin"}'},
          {'notificationId': '', 'target': 42},
        ]) {
          final tap = PushTap.fromData(data);
          expect(tap.target, isA<UnsupportedTarget>());
          expect(tap.notificationId, isNull);
        }
      },
    );
  });
}

/// A server that never answers the device's release.
class _Hanging extends _Notifications {
  _Hanging(super.log);

  @override
  Future<void> unregisterDevice(String deviceId) {
    log.add('unregister');
    return Completer<void>().future;
  }
}

/// The resolver's answer, scripted; it records what it was asked.
class _Resolver implements NotificationTargetResolver {
  TargetResolution answer = const OpenRoute('/somewhere');
  final List<NotificationTarget> asked = [];

  @override
  Future<TargetResolution> resolve(NotificationTarget target) async {
    asked.add(target);
    return answer;
  }
}
