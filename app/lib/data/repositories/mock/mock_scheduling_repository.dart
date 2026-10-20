import '../../../app/app_config.dart';
import '../../models/data_origin.dart';
import '../../models/scheduling.dart';
import '../repositories.dart';

/// A coherent in-memory demo of scheduling: lessons can be created, listed,
/// rescheduled and cancelled, so the Trial shows the real flow without a
/// backend. It does NOT do real DST resolution — the demo's `scheduledAt` is a
/// naive reading of the entered wall clock (the server is the authority); demo
/// rows are marked [DataOrigin.profile].
class MockSchedulingRepository implements SchedulingRepository {
  MockSchedulingRepository();

  int _seq = 0;
  final List<ScheduledLesson> _lessons = [
    _demo('ls-seed-1', 'halaqa-demo-1', 'تلاوة سورة البقرة', '2027-03-01', '09:00'),
    _demo('ls-seed-2', 'halaqa-demo-1', 'مراجعة الحفظ', '2027-03-03', '17:30'),
  ];

  @override
  DataOrigin get origin => DataOrigin.profile;

  static Future<T> _delayed<T>(T value) =>
      Future<T>.delayed(AppConfig.fakeLatency, () => value);

  static DateTime _instantOf(String date, String time) =>
      DateTime.tryParse('${date}T$time:00Z') ?? DateTime.now().toUtc();

  static ScheduledLesson _demo(String id, String halaqaId, String title, String date, String time) {
    final now = DateTime.now().toUtc();
    return ScheduledLesson(
      id: id,
      halaqaId: halaqaId,
      title: title,
      localDate: date,
      localTime: time,
      timezone: 'Asia/Riyadh',
      scheduledAt: _instantOf(date, time),
      status: LessonStatus.scheduled,
      createdAt: now,
      createdBy: 'owner-demo',
      updatedAt: now,
      cancelledAt: null,
      cancelledBy: null,
      origin: DataOrigin.profile,
    );
  }

  ScheduledLesson _byId(String id) {
    for (final lesson in _lessons) {
      if (lesson.id == id) return lesson;
    }
    throw const SchedulingException('operations.lesson_not_found', 'No such lesson.');
  }

  int _indexOf(String id) {
    final index = _lessons.indexWhere((lesson) => lesson.id == id);
    if (index < 0) {
      throw const SchedulingException('operations.lesson_not_found', 'No such lesson.');
    }
    return index;
  }

  @override
  Future<LessonPage> lessons({String? halaqaId, String? cursor}) {
    final items = _lessons.where((l) => halaqaId == null || l.halaqaId == halaqaId).toList()
      ..sort((a, b) => a.scheduledAt.compareTo(b.scheduledAt));
    return _delayed(LessonPage(items: items));
  }

  @override
  Future<ScheduledLesson> lesson(String id) async => _delayed(_byId(id));

  @override
  Future<ScheduledLesson> schedule({
    required String halaqaId,
    String? title,
    required String date,
    required String time,
    required String timezone,
    String? clientRequestId,
  }) {
    final now = DateTime.now().toUtc();
    final lesson = ScheduledLesson(
      id: 'ls-${++_seq}-${now.microsecondsSinceEpoch}',
      halaqaId: halaqaId,
      title: (title != null && title.trim().isNotEmpty) ? title.trim() : null,
      localDate: date,
      localTime: time,
      timezone: timezone,
      scheduledAt: _instantOf(date, time),
      status: LessonStatus.scheduled,
      createdAt: now,
      createdBy: 'owner-demo',
      updatedAt: now,
      cancelledAt: null,
      cancelledBy: null,
      origin: DataOrigin.profile,
    );
    _lessons.add(lesson);
    return _delayed(lesson);
  }

  @override
  Future<ScheduledLesson> reschedule(
    String id, {
    required String date,
    required String time,
    required String timezone,
    String? title,
  }) async {
    final index = _indexOf(id);
    final existing = _lessons[index];
    final updated = ScheduledLesson(
      id: existing.id,
      halaqaId: existing.halaqaId,
      title: (title != null && title.trim().isNotEmpty) ? title.trim() : null,
      localDate: date,
      localTime: time,
      timezone: timezone,
      scheduledAt: _instantOf(date, time),
      status: existing.status,
      createdAt: existing.createdAt,
      createdBy: existing.createdBy,
      updatedAt: DateTime.now().toUtc(),
      cancelledAt: existing.cancelledAt,
      cancelledBy: existing.cancelledBy,
      origin: DataOrigin.profile,
    );
    _lessons[index] = updated;
    return _delayed(updated);
  }

  @override
  Future<ScheduledLesson> cancel(String id) async {
    final index = _indexOf(id);
    final existing = _lessons[index];
    if (existing.status.isCancelled) {
      throw const SchedulingException(
        'operations.lesson_not_modifiable',
        'A cancelled lesson cannot be cancelled again.',
      );
    }
    final now = DateTime.now().toUtc();
    final cancelled = ScheduledLesson(
      id: existing.id,
      halaqaId: existing.halaqaId,
      title: existing.title,
      localDate: existing.localDate,
      localTime: existing.localTime,
      timezone: existing.timezone,
      scheduledAt: existing.scheduledAt,
      status: LessonStatus.cancelled,
      createdAt: existing.createdAt,
      createdBy: existing.createdBy,
      updatedAt: now,
      cancelledAt: now,
      cancelledBy: 'owner-demo',
      origin: DataOrigin.profile,
    );
    _lessons[index] = cancelled;
    return _delayed(cancelled);
  }
}
