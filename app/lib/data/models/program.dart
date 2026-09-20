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
/// Names, halaqa counts and badges are all from the profile PDF. Anything the
/// PDF does not state (a long description, prerequisites, timing) is either
/// absent or explicitly marked as mock at the point of use.
class Program implements Sourced {
  const Program({
    required this.id,
    required this.name,
    required this.kind,
    required this.sourcePage,
    this.order = 0,
    this.halaqatCount,
    this.badge,
    this.description,
    this.items = const [],
    this.levelsCount,
    this.capacityNote,
    this.iconName = 'book',
  });

  final String id;
  final String name;
  final ProgramKind kind;

  /// Page of `docs/institution-profile.pdf` this program was taken from.
  final int sourcePage;

  /// Position on the graded ladder (departments only).
  final int order;

  /// Number of halaqat, as stated on page 6.
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
  DataOrigin get origin => DataOrigin.profile;

  bool get isDepartment => kind == ProgramKind.department;
}
