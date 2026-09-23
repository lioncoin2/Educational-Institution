import 'data_origin.dart';

/// How a program relates to the institution's structure.
enum ProgramKind {
  /// The five graded departments of page 6 — the main ladder.
  department,

  /// The stand-alone sections: التهجي (p7), البراعم (p8), اللغات (p9).
  special,

  /// البرامج المرافقة of page 10.
  companion,
}

/// A program, department or section offered by the institution.
///
/// Names, halaqa counts and badges are all from the profile PDF — or, against
/// the server, from the institution's own records ([DataOrigin.records]),
/// with the profile's descriptive text alongside. Anything neither states (a
/// long description, prerequisites, timing) is absent or explicitly marked
/// as mock at the point of use.
class Program implements Sourced {
  const Program({
    required this.id,
    required this.name,
    required this.kind,
    this.sourcePage,
    this.order = 0,
    this.halaqatCount,
    this.badge,
    this.description,
    this.items = const [],
    this.levelsCount,
    this.capacityNote,
    this.iconName = 'book',
    this.origin = DataOrigin.profile,
  });

  /// Stable across the demo and the server: the code (`dep-literacy`,
  /// `sec-kids`, `prog-nahw`), never a name.
  final String id;
  final String name;
  final ProgramKind kind;

  /// Page of `docs/institution-profile.pdf` the text shown with this program
  /// was taken from; null when none of it was.
  final int? sourcePage;

  /// Position on the graded ladder (departments only).
  final int order;

  /// Number of halaqat, as stated on page 6 — or, against the server, the
  /// ACTIVE halaqat it records. Null when there are none to count.
  final int? halaqatCount;

  /// The badge shown next to companion programs on page 10
  /// (e.g. "30 جزء", "5 مستويات", "لكل قسم").
  final String? badge;

  /// Verbatim description, where the profile provides one (pages 7, 8, 9).
  final String? description;

  /// Sub-items listed in the profile (the three mutun, the five languages).
  final List<String> items;

  /// Stated level count, where the profile gives one (البراعم: 3).
  final int? levelsCount;

  /// Capacity note from the profile (التهجي: "استيعاب 40 مجموعة").
  final String? capacityNote;

  final String iconName;

  @override
  final DataOrigin origin;

  bool get isDepartment => kind == ProgramKind.department;
}
