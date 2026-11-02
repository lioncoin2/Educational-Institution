/// Shared wire pieces of the tasks API (ADR 0052): the typed failure, a page,
/// a person reference, and the defensive readers every tasks model parses with.
library;

/// A refusal from the tasks API, carrying the server's stable code
/// (`tasks.settings_locked`, `tasks.revision_conflict`, …).
class TasksException implements Exception {
  const TasksException(this.code, this.message);

  final String code;
  final String message;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';

  @override
  String toString() => 'TasksException($code): $message';
}

/// One page of a newest-first list, with the cursor of the next one.
class TasksPage<T> {
  const TasksPage({required this.items, this.nextCursor});

  final List<T> items;
  final String? nextCursor;

  bool get hasMore => nextCursor != null;

  TasksPage<T> followedBy(TasksPage<T> next) =>
      TasksPage(items: [...items, ...next.items], nextCursor: next.nextCursor);
}

/// A person as the server shows them: an id, and a name while the account exists.
class PersonRef {
  const PersonRef({required this.id, this.name});

  final String id;
  final String? name;

  factory PersonRef.fromJson(Object? json) {
    final map = TasksWire.map(json);
    return PersonRef(id: TasksWire.string(map, 'id'), name: TasksWire.optionalString(map['name']));
  }

  static PersonRef? maybe(Object? json) => json == null ? null : PersonRef.fromJson(json);
}

/// Defensive readers: a missing required field is a [FormatException], which
/// the repositories turn into an "unreadable" [TasksException].
abstract final class TasksWire {
  static Map<String, Object?> map(Object? json) {
    if (json is Map) return json.cast<String, Object?>();
    throw const FormatException('tasks: expected an object');
  }

  static String string(Map<String, Object?> json, String key) {
    final value = json[key];
    if (value is String && value.isNotEmpty) return value;
    throw FormatException('tasks: missing "$key"');
  }

  /// A required string that may be empty (a task's instructions).
  static String text(Map<String, Object?> json, String key) {
    final value = json[key];
    if (value is String) return value;
    throw FormatException('tasks: missing "$key"');
  }

  static String? optionalString(Object? value) =>
      value is String && value.isNotEmpty ? value : null;

  static int integer(Map<String, Object?> json, String key) {
    final value = json[key];
    if (value is int) return value;
    if (value is num) return value.toInt();
    throw FormatException('tasks: missing "$key"');
  }

  static int? optionalInteger(Object? value) => value is num ? value.toInt() : null;

  static double? optionalNumber(Object? value) => value is num ? value.toDouble() : null;

  static bool flag(Map<String, Object?> json, String key) => json[key] == true;

  static DateTime instant(Map<String, Object?> json, String key) {
    final value = json[key];
    final parsed = value is String ? DateTime.tryParse(value) : null;
    if (parsed == null) throw FormatException('tasks: missing "$key"');
    return parsed;
  }

  static DateTime? optionalInstant(Object? value) =>
      value is String ? DateTime.tryParse(value) : null;

  static List<String> strings(Object? value) =>
      value is List ? value.whereType<String>().toList(growable: false) : const [];

  /// Each readable item of a list; an unreadable one is skipped, not fatal.
  static List<T> list<T>(Object? json, T Function(Map<String, Object?>) parse) {
    if (json is! List) return const [];
    final items = <T>[];
    for (final item in json) {
      if (item is! Map) continue;
      try {
        items.add(parse(item.cast<String, Object?>()));
      } on FormatException {
        // Skip the unreadable row.
      } on TypeError {
        // Skip the unreadable row.
      }
    }
    return items;
  }

  static TasksPage<T> page<T>(Map<String, Object?> json, T Function(Map<String, Object?>) parse) =>
      TasksPage(items: list(json['items'], parse), nextCursor: optionalString(json['nextCursor']));
}
