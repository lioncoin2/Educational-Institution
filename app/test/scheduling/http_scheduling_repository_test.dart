import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:quran_institution_app/data/api/api_client.dart';
import 'package:quran_institution_app/data/api/token_store.dart';
import 'package:quran_institution_app/data/models/scheduling.dart';
import 'package:quran_institution_app/data/repositories/http/http_scheduling_repository.dart';

void main() {
  late InMemoryTokenStore tokens;
  final recorded = <http.Request>[];

  HttpSchedulingRepository over(http.Response Function(http.Request) handler) {
    final client = MockClient((request) async {
      recorded.add(request);
      return handler(request);
    });
    return HttpSchedulingRepository(
      ApiClient(baseUri: Uri.parse('https://api.test/'), httpClient: client, tokenStore: tokens),
    );
  }

  setUp(() async {
    recorded.clear();
    tokens = InMemoryTokenStore();
    await tokens.write(const Tokens(accessToken: 'a1', refreshToken: 'r1'));
  });

  Map<String, Object?> lessonRow({String status = 'SCHEDULED'}) => {
        'id': 'ls-1',
        'halaqaId': 'h-1',
        'title': 'الدرس',
        'localDate': '2027-03-01',
        'localTime': '09:00',
        'timezone': 'Asia/Riyadh',
        'scheduledAt': '2027-03-01T06:00:00.000Z',
        'status': status,
        'createdAt': '2026-10-20T08:00:00.000Z',
        'createdBy': 'owner-1',
        'updatedAt': '2026-10-20T08:00:00.000Z',
        'cancelledAt': null,
        'cancelledBy': null,
      };

  http.Response ok(Object body) => http.Response(
        jsonEncode(body),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );
  http.Response fail(int status, String code) => http.Response(
        jsonEncode({
          'error': {'kind': 'x', 'code': code, 'message': code},
        }),
        status,
        headers: {'content-type': 'application/json; charset=utf-8'},
      );

  http.Request req() => recorded.single;
  Map<String, Object?> sentBody() => jsonDecode(req().body) as Map<String, Object?>;

  test('schedule POSTs the wall clock, timezone and idempotency key', () async {
    final repo = over((_) => ok(lessonRow()));
    final lesson = await repo.schedule(
      halaqaId: 'h-1',
      title: 'الدرس',
      date: '2027-03-01',
      time: '09:00',
      timezone: 'Asia/Riyadh',
      clientRequestId: 'req-1',
    );
    expect(req().method, 'POST');
    expect(req().url.path, '/operations/lessons');
    expect(sentBody(), {
      'halaqaId': 'h-1',
      'title': 'الدرس',
      'date': '2027-03-01',
      'time': '09:00',
      'timezone': 'Asia/Riyadh',
      'clientRequestId': 'req-1',
    });
    expect(lesson.scheduledAt.toUtc().toIso8601String(), '2027-03-01T06:00:00.000Z');
  });

  test('lessons GETs the list with a halaqa filter and parses the page', () async {
    final repo = over((_) => ok({
          'items': [lessonRow()],
          'nextCursor': 'c2',
        }));
    final page = await repo.lessons(halaqaId: 'h-1');
    expect(req().method, 'GET');
    expect(req().url.path, '/operations/lessons');
    expect(req().url.queryParameters['halaqaId'], 'h-1');
    expect(page.items, hasLength(1));
    expect(page.nextCursor, 'c2');
  });

  test('reschedule PATCHes the escaped id and sends the new time', () async {
    final repo = over((_) => ok(lessonRow()));
    await repo.reschedule('ls 1', date: '2027-04-01', time: '08:00', timezone: 'Asia/Riyadh');
    expect(req().method, 'PATCH');
    expect(req().url.path, '/operations/lessons/ls%201');
    expect(sentBody()['date'], '2027-04-01');
    expect(sentBody()['title'], isNull); // null clears
  });

  test('cancel POSTs to the cancel sub-path', () async {
    final repo = over((_) => ok(lessonRow(status: 'CANCELLED')));
    final lesson = await repo.cancel('ls-1');
    expect(req().method, 'POST');
    expect(req().url.path, '/operations/lessons/ls-1/cancel');
    expect(lesson.status, LessonStatus.cancelled);
  });

  test('maps a backend refusal to a typed SchedulingException with the code', () async {
    final repo = over((_) => fail(422, 'operations.local_time_nonexistent'));
    await expectLater(
      repo.schedule(
        halaqaId: 'h-1',
        date: '2027-03-14',
        time: '02:30',
        timezone: 'America/New_York',
      ),
      throwsA(isA<SchedulingException>()
          .having((e) => e.code, 'code', 'operations.local_time_nonexistent')),
    );
  });
}
