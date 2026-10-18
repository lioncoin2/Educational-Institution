import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/repositories/repositories.dart';
import 'package:quran_institution_app/features/profile/state/sessions_controller.dart';
import 'package:quran_institution_app/providers/app_providers.dart';

/// «الأجهزة والجلسات» sits on the profile tab, which stays mounted: its list
/// must follow the signed-in account, never show the last one's devices.
String? _signedIn;

class _Auth implements AuthRepository {
  @override
  Future<CurrentUser?> currentUser() async => _signedIn == null
      ? null
      : CurrentUser(
          id: _signedIn!,
          displayName: _signedIn!,
          status: AccountStatus.active,
          roles: const [],
          permissions: const {},
        );

  @override
  Future<List<DeviceSession>> sessions() async => [
    DeviceSession.fromJson({
      'id': 'session-of-$_signedIn',
      'device': <String, Object?>{'platform': 'web'},
      'lastUsedAt': '2026-01-01T00:00:00Z',
      'current': true,
    }),
  ];

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

void main() {
  test('the device list is read again when the account changes', () async {
    _signedIn = 'a';
    final container = ProviderContainer(
      overrides: [
        backendModeProvider.overrideWithValue(true),
        authRepositoryProvider.overrideWithValue(_Auth()),
      ],
    );
    addTearDown(container.dispose);
    await container.read(sessionUserProvider.future);
    container.listen(sessionsProvider, (_, _) {});
    expect(
      (await container.read(sessionsProvider.future)).single.id,
      'session-of-a',
    );

    _signedIn = 'b';
    container.invalidate(sessionUserProvider);
    await container.read(sessionUserProvider.future);
    await pumpEventQueue();

    expect((await container.read(sessionsProvider.future)).map((s) => s.id), [
      'session-of-b',
    ]);
  });
}
