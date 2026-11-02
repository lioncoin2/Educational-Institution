import '../../../api/api_client.dart';
import '../../../models/tasks/tasks.dart';

/// What the four tasks HTTP repositories share: one failure mapping, so a
/// transport refusal becomes a [TasksException] with the server's code and an
/// unreadable answer never shows up as fabricated data.
abstract final class TasksHttp {
  static const unreadable =
      TasksException('tasks.unreadable', 'The server sent something this app cannot read.');

  static Future<T> call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on ApiException catch (error) {
      throw TasksException(error.code, error.message);
    } on FormatException {
      throw unreadable;
    } on TypeError {
      throw unreadable;
    }
  }

  static String segment(String id) => Uri.encodeComponent(id);

  /// A query without empty values, or null when nothing is left.
  static Map<String, String>? query(Map<String, String?> values) {
    final kept = {
      for (final MapEntry(:key, :value) in values.entries)
        if (value != null && value.isNotEmpty) key: value,
    };
    return kept.isEmpty ? null : kept;
  }
}
