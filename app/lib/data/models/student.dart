import 'data_origin.dart';

/// The person using the app. In the demo it is a fixed placeholder learner
/// ([DataOrigin.mock]); against the server it is the signed-in account and
/// its academic record ([DataOrigin.records]) — and whatever that record does
/// not hold is null, never filled in.
class StudentProfile implements Sourced {
  const StudentProfile({
    required this.name,
    required this.initials,
    this.targetGroupName,
    this.currentProgramId,
    this.currentProgramName,
    this.joinedLabel,
    this.origin = DataOrigin.mock,
  });

  final String name;

  /// One of the five groups on page 4 of the profile.
  final String? targetGroupName;

  final String? currentProgramId;

  /// Where they study now.
  final String? currentProgramName;
  final String? joinedLabel;
  final String initials;

  @override
  final DataOrigin origin;
}
