import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/auth.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_auth_repository.dart';

void main() {
  group('auth models parse the backend contract exactly', () {
    // The shape of GET /auth/me (backend/src/modules/identity/api/responses.ts).
    const me = {
      'id': '0b4e7a52-5d0c-4d3a-9d4e-1f2a3b4c5d6e',
      'displayName': 'Amina',
      'status': 'ACTIVE',
      'roles': ['STUDENT'],
      'permissions': ['live.join', 'live.raise_hand'],
    };

    test('CurrentUser', () {
      final user = CurrentUser.fromJson(me);
      expect(user.id, me['id']);
      expect(user.status, AccountStatus.active);
      expect(user.roles, ['STUDENT']);
      expect(user.can('live.raise_hand'), isTrue);
      expect(user.can('live.moderate'), isFalse);
      expect(user.origin, DataOrigin.profile);
    });

    test('an account state the client does not know degrades to unknown', () {
      expect(AccountStatus.fromWire('ARCHIVED'), AccountStatus.unknown);
      expect(AccountStatus.fromWire('SUSPENDED'), AccountStatus.suspended);
    });

    test('DeviceSession', () {
      final session = DeviceSession.fromJson({
        'id': 's-1',
        'device': {
          'platform': 'ios',
          'label': "Amina's iPhone",
          'appVersion': '1.0.0',
        },
        'createdAt': '2026-09-01T08:00:00.000Z',
        'lastUsedAt': '2026-09-02T08:00:00.000Z',
        'expiresAt': '2026-10-01T08:00:00.000Z',
        'current': true,
      });
      expect(session.platform, 'ios');
      expect(session.label, "Amina's iPhone");
      expect(session.lastUsedAt, DateTime.utc(2026, 9, 2, 8));
      expect(session.current, isTrue);
    });
  });

  group('MockAuthRepository behaves like the contract', () {
    test('signs in, reports the user, and signs out', () async {
      final auth = MockAuthRepository();
      expect(await auth.currentUser(), isNull);

      final user = await auth.signIn(
        identifier: 'anyone@example.com',
        password: 'anything',
      );
      expect(user.origin, DataOrigin.mock); // never mistaken for real data
      expect(await auth.currentUser(), same(user));

      await auth.signOut();
      expect(await auth.currentUser(), isNull);
    });

    // It holds no credential to check against, by design.
    test('refuses only empty input', () async {
      final auth = MockAuthRepository();
      expect(
        () => auth.signIn(identifier: ' ', password: 'x'),
        throwsA(
          isA<AuthException>().having(
            (e) => e.code,
            'code',
            'identity.invalid_credentials',
          ),
        ),
      );
    });

    test('lists devices only when signed in, and ends one by id', () async {
      final auth = MockAuthRepository();
      expect(auth.sessions(), throwsA(isA<AuthException>()));

      await auth.signIn(identifier: 'a@example.com', password: 'x');
      await auth.signIn(identifier: 'a@example.com', password: 'x');
      final sessions = await auth.sessions();
      expect(sessions, hasLength(2));
      expect(sessions.where((s) => s.current), hasLength(1));

      await auth.endSession(sessions.firstWhere((s) => !s.current).id);
      expect(await auth.sessions(), hasLength(1));
      expect(await auth.currentUser(), isNotNull);
    });

    test('ending the current session signs this device out', () async {
      final auth = MockAuthRepository();
      await auth.signIn(identifier: 'a@example.com', password: 'x');
      final current = (await auth.sessions()).single;
      await auth.endSession(current.id);
      expect(await auth.currentUser(), isNull);
    });

    test('reports a missing session as not found', () async {
      final auth = MockAuthRepository();
      await auth.signIn(identifier: 'a@example.com', password: 'x');
      expect(
        () => auth.endSession('nope'),
        throwsA(
          isA<AuthException>().having(
            (e) => e.code,
            'code',
            'identity.session_not_found',
          ),
        ),
      );
    });
  });
}
