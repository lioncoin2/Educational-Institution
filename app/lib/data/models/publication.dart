/// The outcome of a mass publish to several communities
/// (`POST /messaging/communities/publish`).
///
/// Defensive and read-only: the server decides each community's fate and this
/// parses it so an unknown status is surfaced as [PublicationStatus.unknown]
/// rather than crashing. Nothing here is invented — the app shows exactly what
/// the server reported, per community.
library;

import 'data_origin.dart';

/// Per community, what happened — mirrors the server's vocabulary.
enum PublicationStatus {
  posted('posted'),
  alreadyPosted('already_posted'),
  forbidden('forbidden'),
  notFound('not_found'),
  locked('locked'),
  overCapacity('over_capacity'),
  rateLimited('rate_limited'),
  unavailable('unavailable'),
  failed('failed'),
  unknown('unknown');

  const PublicationStatus(this.wire);

  final String wire;

  static PublicationStatus fromWire(String? value) {
    for (final status in PublicationStatus.values) {
      if (status.wire == value) return status;
    }
    return PublicationStatus.unknown;
  }

  /// The message reached this community (a fresh post, or an idempotent retry
  /// that found the earlier one).
  bool get isSuccess => this == posted || this == alreadyPosted;
}

/// One community's outcome.
class PublicationOutcome {
  const PublicationOutcome({
    required this.communityId,
    required this.status,
    required this.retryable,
    this.messageId,
  });

  factory PublicationOutcome.fromJson(Map<String, Object?> json) =>
      PublicationOutcome(
        communityId: json['communityId'] is String
            ? json['communityId']! as String
            : '',
        status: PublicationStatus.fromWire(
          json['status'] is String ? json['status']! as String : null,
        ),
        retryable: json['retryable'] == true,
        messageId: json['messageId'] is String
            ? json['messageId']! as String
            : null,
      );

  final String communityId;
  final PublicationStatus status;
  final bool retryable;
  final String? messageId;
}

/// The whole batch: the server's [batchId] echoed back, and each community's
/// [results]. [DataOrigin] marks whether the figures are real or a demo.
class PublicationReport implements Sourced {
  const PublicationReport({
    required this.batchId,
    required this.results,
    this.origin = DataOrigin.records,
  });

  factory PublicationReport.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) {
    final results = json['results'];
    return PublicationReport(
      batchId: json['batchId'] is String ? json['batchId']! as String : '',
      results: results is List
          ? [
              for (final item in results)
                if (item is Map)
                  PublicationOutcome.fromJson(item.cast<String, Object?>()),
            ]
          : const [],
      origin: origin,
    );
  }

  final String batchId;
  final List<PublicationOutcome> results;

  @override
  final DataOrigin origin;

  int get total => results.length;
  int get posted => results.where((r) => r.status.isSuccess).length;
  int get failed => total - posted;

  /// The community ids a plain retry can still clear (transient refusals only).
  List<String> get retryableCommunityIds => [
    for (final r in results)
      if (r.retryable) r.communityId,
  ];
}
