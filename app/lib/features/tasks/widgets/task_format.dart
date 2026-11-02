import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';

/// How the tasks screens write times, people and rates.
abstract final class TaskFormat {
  /// `2/11/2026 08:05`, in the viewer's local time.
  static String when(DateTime at) {
    final local = at.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${local.day}/${local.month}/${local.year} ${two(local.hour)}:${two(local.minute)}';
  }

  static String? maybeWhen(DateTime? at) => at == null ? null : when(at);

  /// A name, or a plain "unknown account" — never an id in place of a name.
  static String person(PersonRef? person) =>
      person == null ? TasksCopy.system : (person.name ?? TasksCopy.unknownPerson);

  static String rate(double? percent) => percent == null ? TasksCopy.noRate : '$percent٪';
}
