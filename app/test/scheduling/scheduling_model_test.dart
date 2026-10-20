import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/scheduling.dart';

Map<String, Object?> row({String status = 'SCHEDULED', Object? title = 'الدرس'}) => {
      'id': 'ls-1',
      'halaqaId': 'h-1',
      'title': title,
      'localDate': '2027-03-01',
      'localTime': '09:00',
      'timezone': 'Asia/Riyadh',
      'scheduledAt': '2027-03-01T06:00:00.000Z',
      'status': status,
      'createdAt': '2026-10-20T08:00:00.000Z',
      'createdBy': 'owner-1',
      'updatedAt': '2026-10-20T08:00:00.000Z',
      'cancelledAt': status == 'CANCELLED' ? '2026-10-20T09:00:00.000Z' : null,
      'cancelledBy': status == 'CANCELLED' ? 'owner-1' : null,
    };

void main() {
  test('parses a scheduled lesson, preserving the wall clock and instant', () {
    final lesson = ScheduledLesson.fromJson(row());
    expect(lesson.id, 'ls-1');
    expect(lesson.localDate, '2027-03-01');
    expect(lesson.localTime, '09:00');
    expect(lesson.timezone, 'Asia/Riyadh');
    expect(lesson.scheduledAt.toUtc().toIso8601String(), '2027-03-01T06:00:00.000Z');
    expect(lesson.status, LessonStatus.scheduled);
    expect(lesson.title, 'الدرس');
    expect(lesson.cancelledAt, isNull);
  });

  test('parses a cancelled lesson with its audit fields', () {
    final lesson = ScheduledLesson.fromJson(row(status: 'CANCELLED'));
    expect(lesson.status, LessonStatus.cancelled);
    expect(lesson.status.isCancelled, isTrue);
    expect(lesson.cancelledBy, 'owner-1');
    expect(lesson.cancelledAt, isNotNull);
  });

  test('treats a missing title as null and an unknown status tolerantly', () {
    final lesson = ScheduledLesson.fromJson(row(title: null, status: 'WAT'));
    expect(lesson.title, isNull);
    expect(lesson.status, LessonStatus.unknown);
  });

  test('listFromJson skips unreadable rows instead of throwing', () {
    final list = ScheduledLesson.listFromJson([row(), 'garbage', <String, Object?>{'id': ''}]);
    expect(list, hasLength(1));
    expect(list.single.id, 'ls-1');
  });

  test('LessonStatus.fromWire maps the wire codes', () {
    expect(LessonStatus.fromWire('SCHEDULED'), LessonStatus.scheduled);
    expect(LessonStatus.fromWire('CANCELLED'), LessonStatus.cancelled);
    expect(LessonStatus.fromWire(null), LessonStatus.unknown);
  });
}
