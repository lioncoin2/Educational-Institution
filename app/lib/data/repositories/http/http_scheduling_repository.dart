import '../../api/api_client.dart';
import '../../models/data_origin.dart';
import '../../models/scheduling.dart';
import '../repositories.dart';

/// Talks to `/operations/lessons`. Transport failures become a typed
/// [SchedulingException] carrying the server's stable code, so the UI can
/// render an Arabic message and never shows a fabricated schedule.
class HttpSchedulingRepository implements SchedulingRepository {
  HttpSchedulingRepository(this._api);

  final ApiClient _api;

  @override
  DataOrigin get origin => DataOrigin.records;

  static const _unreadable =
      SchedulingException('operations.unreadable', 'The server sent something this app cannot read.');

  static Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw SchedulingException(error.code, error.message);
    } on FormatException {
      throw _unreadable;
    } on TypeError {
      throw _unreadable;
    }
  }

  String _lesson(String id) => '/operations/lessons/${Uri.encodeComponent(id)}';

  @override
  Future<LessonPage> lessons({String? halaqaId, String? cursor}) => _call(() async {
        final query = <String, String>{
          if (halaqaId != null && halaqaId.isNotEmpty) 'halaqaId': halaqaId,
          if (cursor != null && cursor.isNotEmpty) 'cursor': cursor,
        };
        final json = await _api.get('/operations/lessons', query: query.isEmpty ? null : query);
        final next = json['nextCursor'];
        return LessonPage(
          items: ScheduledLesson.listFromJson(json['items']),
          nextCursor: next is String && next.isNotEmpty ? next : null,
        );
      });

  @override
  Future<ScheduledLesson> lesson(String id) =>
      _call(() async => ScheduledLesson.fromJson(await _api.get(_lesson(id))));

  @override
  Future<ScheduledLesson> schedule({
    required String halaqaId,
    String? title,
    required String date,
    required String time,
    required String timezone,
    String? clientRequestId,
  }) =>
      _call(() async => ScheduledLesson.fromJson(
            await _api.post('/operations/lessons', body: {
              'halaqaId': halaqaId,
              if (title != null && title.isNotEmpty) 'title': title,
              'date': date,
              'time': time,
              'timezone': timezone,
              'clientRequestId': ?clientRequestId,
            }),
          ));

  @override
  Future<ScheduledLesson> reschedule(
    String id, {
    required String date,
    required String time,
    required String timezone,
    String? title,
  }) =>
      _call(() async => ScheduledLesson.fromJson(
            await _api.patch(_lesson(id), body: {
              'date': date,
              'time': time,
              'timezone': timezone,
              'title': title, // null clears the title
            }),
          ));

  @override
  Future<ScheduledLesson> cancel(String id) =>
      _call(() async => ScheduledLesson.fromJson(await _api.post('${_lesson(id)}/cancel')));
}
