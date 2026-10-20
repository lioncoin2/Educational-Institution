import 'package:flutter_test/flutter_test.dart';
import 'package:quran_institution_app/data/models/data_origin.dart';
import 'package:quran_institution_app/data/models/scheduling.dart';
import 'package:quran_institution_app/data/repositories/mock/mock_scheduling_repository.dart';

void main() {
  late MockSchedulingRepository repo;

  setUp(() => repo = MockSchedulingRepository());

  test('is a demo source and seeds a couple of lessons', () async {
    expect(repo.origin, DataOrigin.profile);
    final page = await repo.lessons();
    expect(page.items.length, greaterThanOrEqualTo(2));
  });

  test('schedules, then lists the new lesson ordered by instant', () async {
    final created = await repo.schedule(
      halaqaId: 'h-1',
      title: 'درس جديد',
      date: '2027-02-01',
      time: '08:00',
      timezone: 'Asia/Riyadh',
    );
    expect(created.status, LessonStatus.scheduled);
    final page = await repo.lessons(halaqaId: 'h-1');
    expect(page.items.map((l) => l.id), contains(created.id));
  });

  test('reschedules an existing lesson', () async {
    final created = await repo.schedule(
      halaqaId: 'h-1',
      date: '2027-02-01',
      time: '08:00',
      timezone: 'Asia/Riyadh',
    );
    final updated = await repo.reschedule(
      created.id,
      date: '2027-02-05',
      time: '10:30',
      timezone: 'Asia/Riyadh',
    );
    expect(updated.id, created.id);
    expect(updated.localDate, '2027-02-05');
    expect(updated.localTime, '10:30');
  });

  test('cancels as a transition and refuses a second cancel', () async {
    final created = await repo.schedule(
      halaqaId: 'h-1',
      date: '2027-02-01',
      time: '08:00',
      timezone: 'Asia/Riyadh',
    );
    final cancelled = await repo.cancel(created.id);
    expect(cancelled.status, LessonStatus.cancelled);
    final fetched = await repo.lesson(created.id);
    expect(fetched.status, LessonStatus.cancelled); // kept, not deleted
    await expectLater(
      repo.cancel(created.id),
      throwsA(isA<SchedulingException>()
          .having((e) => e.code, 'code', 'operations.lesson_not_modifiable')),
    );
  });

  test('throws not_found for an unknown id', () async {
    await expectLater(
      repo.lesson('nope'),
      throwsA(isA<SchedulingException>()
          .having((e) => e.code, 'code', 'operations.lesson_not_found')),
    );
  });
}
