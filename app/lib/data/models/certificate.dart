import 'data_origin.dart';

/// The three kinds named on page 13 of the profile.
enum CertificateKind {
  educational('شهادة تعليمية'),
  appreciation('شهادة تقديرية'),
  ijazah('إجازة');

  const CertificateKind(this.label);
  final String label;
}

enum CertificateStatus { issued, inProgress }

/// A certificate record. The three kinds are real; every certificate instance
/// below is mock.
class Certificate implements Sourced {
  const Certificate({
    required this.id,
    required this.kind,
    required this.title,
    required this.programName,
    required this.status,
    required this.issuedLabel,
    required this.referenceCode,
    this.progressNote,
  });

  final String id;
  final CertificateKind kind;
  final String title;
  final String programName;
  final CertificateStatus status;
  final String issuedLabel;

  /// Page 13 mentions documented archiving; this stands in for the reference.
  final String referenceCode;

  /// Shown for certificates that are still being earned.
  final String? progressNote;

  @override
  DataOrigin get origin => DataOrigin.mock;
}
