import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/command_center.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/repositories/http/http_reporting_repository.dart';

/// [HttpReportingRepository] against a scripted server: the exact
/// command-center route, the widget/metric parse, and every refusal mapped to
/// [ReportingException] rather than thrown raw.
void main() {
  final base = Uri.parse('https://api.example.org/');

  Future<ApiClient> api(http.Client client) async {
    final store = InMemoryTokenStore();
    await store.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
    return ApiClient(baseUri: base, httpClient: client, tokenStore: store);
  }

  http.Client serving(int status, Object body) => MockClient(
    (_) async => http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json'},
    ),
  );

  test('GETs /reporting/command-center, sends the bearer, parses widgets', () async {
    late http.BaseRequest seen;
    final client = MockClient((request) async {
      seen = request;
      return http.Response(
        jsonEncode({
          'widgets': [
            {
              'id': 'communities.summary',
              'category': 'today',
              'title': 'المجتمعات',
              'payload': {
                'metrics': [
                  {'key': 'total', 'label': 'إجمالي المجتمعات', 'value': 3},
                ],
              },
            },
          ],
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final repo = HttpReportingRepository(await api(client));

    final center = await repo.commandCenter();
    expect(center.widgets.single.id, 'communities.summary');
    expect(center.widgets.single.metrics.single.value, 3);
    expect(center.origin, DataOrigin.records);
    expect(seen.method, 'GET');
    expect(seen.url.path, '/reporting/command-center');
    expect(seen.headers['authorization'], 'Bearer a1');
  });

  test('an empty widget set decodes to an empty, non-error center', () async {
    final repo = HttpReportingRepository(await api(serving(200, {'widgets': <Object?>[]})));
    final center = await repo.commandCenter();
    expect(center.isEmpty, isTrue);
  });

  test('maps a 403 to ReportingException.isForbidden with the server code', () async {
    final repo = HttpReportingRepository(
      await api(
        serving(403, {
          'error': {'code': 'identity.permission_denied', 'message': 'no'},
        }),
      ),
    );
    await expectLater(
      repo.commandCenter(),
      throwsA(
        isA<ReportingException>()
            .having((e) => e.code, 'code', 'identity.permission_denied')
            .having((e) => e.isForbidden, 'isForbidden', isTrue),
      ),
    );
  });

  test('maps a 401 to needsSignIn and a 503 to isUnavailable', () async {
    final unauth = HttpReportingRepository(
      await api(
        serving(401, {
          'error': {'code': 'identity.authentication_required', 'message': 'no'},
        }),
      ),
    );
    await expectLater(
      unauth.commandCenter(),
      throwsA(isA<ReportingException>().having((e) => e.needsSignIn, 'needsSignIn', isTrue)),
    );

    final down = HttpReportingRepository(
      await api(
        serving(503, {
          'error': {'code': 'unavailable', 'message': 'down'},
        }),
      ),
    );
    await expectLater(
      down.commandCenter(),
      throwsA(isA<ReportingException>().having((e) => e.isUnavailable, 'isUnavailable', isTrue)),
    );
  });

  test('reports an unreadable body as reporting.unreadable, not a raw throw', () async {
    // `widgets` is not a list the parser can read element-wise — but the model
    // reads defensively, so instead force an unreadable top-level shape.
    final repo = HttpReportingRepository(await api(serving(200, '[]')));
    await expectLater(
      repo.commandCenter(),
      throwsA(
        isA<ReportingException>().having((e) => e.code, 'code', 'reporting.unreadable'),
      ),
    );
  });
}
