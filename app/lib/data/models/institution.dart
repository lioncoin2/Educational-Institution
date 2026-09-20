import 'data_origin.dart';

/// The institution's own description. Every field comes from the profile PDF.
class Institution implements Sourced {
  const Institution({
    required this.name,
    required this.shortName,
    required this.tagline,
    required this.about,
    required this.mission,
    required this.targetGroups,
    required this.fields,
    required this.futureHorizons,
    required this.certificateKinds,
  });

  /// Page 1 of the profile.
  final String name;

  /// Shortened form used where the full name would not fit.
  final String shortName;

  /// Page 1 subtitle.
  final String tagline;

  /// Page 3, verbatim.
  final String about;

  /// Page 3, the closing clause.
  final String mission;

  /// Page 4.
  final List<TargetGroup> targetGroups;

  /// Page 5.
  final List<StudyField> fields;

  /// Page 14.
  final List<String> futureHorizons;

  /// Page 13.
  final List<String> certificateKinds;

  @override
  DataOrigin get origin => DataOrigin.profile;
}

class TargetGroup implements Sourced {
  const TargetGroup({
    required this.id,
    required this.name,
    this.detail,
  });

  final String id;
  final String name;

  /// Only "البراعم" carries a detail in the profile (ages 3–12).
  final String? detail;

  @override
  DataOrigin get origin => DataOrigin.profile;
}

class StudyField implements Sourced {
  const StudyField({required this.id, required this.name});

  final String id;
  final String name;

  @override
  DataOrigin get origin => DataOrigin.profile;
}
