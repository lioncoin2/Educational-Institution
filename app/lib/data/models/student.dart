import 'data_origin.dart';

/// The signed-in learner. There is no authentication in this prototype — this
/// is a fixed placeholder profile.
class StudentProfile implements Sourced {
  const StudentProfile({
    required this.name,
    required this.targetGroupName,
    required this.currentProgramId,
    required this.currentProgramName,
    required this.joinedLabel,
    required this.initials,
  });

  final String name;

  /// One of the five groups on page 4 of the profile.
  final String targetGroupName;

  final String currentProgramId;
  final String currentProgramName;
  final String joinedLabel;
  final String initials;

  @override
  DataOrigin get origin => DataOrigin.mock;
}
