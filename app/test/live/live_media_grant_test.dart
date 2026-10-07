import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/live.dart';
import 'package:quran_institution_app/data/models/live_media.dart';

/// [LiveMediaGrant] against the exact backend `JoinTicketResponse` shape, and
/// the one security property that matters: the credential never leaks through
/// the grant's string form.
void main() {
  // A JWT-shaped credential, so the redaction test is not vacuous.
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTE.s3cr3t-signature';

  Map<String, Object?> ticket({Object? role = 'speaker'}) => {
    'sessionId': 's-1',
    'token': token,
    'url': 'wss://live.example.org',
    'expiresInSeconds': 120,
    'expiresAt': '2026-01-01T00:02:00.000Z',
    'role': role,
    'media': {'microphone': true, 'screen': false, 'screenAudio': false},
  };

  group('LiveMediaGrant.fromJson', () {
    test('parses every field of the join ticket', () {
      final grant = LiveMediaGrant.fromJson(ticket());
      expect(grant.sessionId, 's-1');
      expect(grant.token, token);
      expect(grant.url, 'wss://live.example.org');
      expect(grant.expiresInSeconds, 120);
      expect(grant.expiresAt, DateTime.utc(2026, 1, 1, 0, 2));
      expect(grant.role, LiveParticipantRole.speaker);
      expect(grant.microphone, isTrue);
      expect(grant.screen, isFalse);
      expect(grant.screenAudio, isFalse);
    });

    test('maps an unknown role to unknown, missing media flags to false', () {
      final grant = LiveMediaGrant.fromJson({
        'sessionId': 's-1',
        'token': token,
        'url': 'wss://x',
        'expiresInSeconds': 60,
        'expiresAt': '2026-01-01T00:01:00.000Z',
        'role': 'future_role',
        // no media block at all
      });
      expect(grant.role, LiveParticipantRole.unknown);
      expect(grant.microphone, isFalse);
      expect(grant.screen, isFalse);
      expect(grant.screenAudio, isFalse);
    });

    test('throws on a missing/unreadable required field', () {
      for (final key in ['sessionId', 'token', 'url', 'expiresAt']) {
        final bad = ticket()..remove(key);
        expect(
          () => LiveMediaGrant.fromJson(bad),
          throwsA(isA<FormatException>()),
          reason: key,
        );
      }
      // A non-string token is unreadable too.
      expect(
        () => LiveMediaGrant.fromJson(ticket()..['token'] = 123),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('token security', () {
    test('toString redacts the credential', () {
      final grant = LiveMediaGrant.fromJson(ticket());
      final shown = grant.toString();
      expect(shown, contains('<redacted>'));
      expect(shown, isNot(contains(token)));
      // Not even a fragment of the JWT leaks.
      expect(shown, isNot(contains('eyJhbGci')));
      expect(shown, isNot(contains('s3cr3t')));
      // The non-secret fields are still legible for diagnostics.
      expect(shown, contains('s-1'));
      expect(shown, contains('speaker'));
    });
  });
}
