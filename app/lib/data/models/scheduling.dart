/// Wire models for operations scheduling — individual dated lessons (ADR 0042).
///
/// Parsed defensively from the backend JSON. A lesson carries the wall clock it
/// was scheduled at (`localDate` + `localTime` + `timezone`, captured at
/// creation) and the resolved `scheduledAt` instant.
library;

import 'data_origin.dart';

enum LessonStatus {
  scheduled('SCHEDULED'),
  cancelled('CANCELLED'),
  unknown('UNKNOWN');

  const LessonStatus(this.wire);

  final String wire;

  static LessonStatus fromWire(Object? value) =>
      values.firstWhere((status) => status.wire == value, orElse: () => unknown);

  bool get isScheduled => this == LessonStatus.scheduled;
  bool get isCancelled => this == LessonStatus.cancelled;
}

class ScheduledLesson implements Sourced {
  const ScheduledLesson({
    required this.id,
    required this.halaqaId,
    required this.title,
    required this.localDate,
    required this.localTime,
    required this.timezone,
    required this.scheduledAt,
    required this.status,
    required this.createdAt,
    required this.createdBy,
    required this.updatedAt,
    required this.cancelledAt,
    required this.cancelledBy,
    this.origin = DataOrigin.records,
  });

  final String id;
  final String halaqaId;
  final String? title;
  final String localDate;
  final String localTime;
  final String timezone;
  final DateTime scheduledAt;
  final LessonStatus status;
  final DateTime createdAt;
  final String createdBy;
  final DateTime updatedAt;
  final DateTime? cancelledAt;
  final String? cancelledBy;

  @override
  final DataOrigin origin;

  factory ScheduledLesson.fromJson(Map<String, Object?> json, {DataOrigin origin = DataOrigin.records}) {
    return ScheduledLesson(
      id: _required(json, 'id'),
      halaqaId: _required(json, 'halaqaId'),
      title: _optional(json['title']),
      localDate: _required(json, 'localDate'),
      localTime: _required(json, 'localTime'),
      timezone: _required(json, 'timezone'),
      scheduledAt: _instant(json, 'scheduledAt'),
      status: LessonStatus.fromWire(json['status']),
      createdAt: _instant(json, 'createdAt'),
      createdBy: _required(json, 'createdBy'),
      updatedAt: _instant(json, 'updatedAt'),
      cancelledAt: _optionalInstant(json['cancelledAt']),
      cancelledBy: _optional(json['cancelledBy']),
      origin: origin,
    );
  }

  static List<ScheduledLesson> listFromJson(Object? json, {DataOrigin origin = DataOrigin.records}) {
    if (json is! List) return const [];
    final lessons = <ScheduledLesson>[];
    for (final item in json) {
      if (item is Map) {
        try {
          lessons.add(ScheduledLesson.fromJson(item.cast<String, Object?>(), origin: origin));
        } on FormatException {
          // Skip an unreadable row rather than failing the whole list.
        } on TypeError {
          // Skip.
        }
      }
    }
    return lessons;
  }
}

class LessonPage {
  const LessonPage({required this.items, this.nextCursor});

  final List<ScheduledLesson> items;
  final String? nextCursor;
}

class SchedulingException implements Exception {
  const SchedulingException(this.code, this.message);

  final String code;
  final String message;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';

  @override
  String toString() => 'SchedulingException($code): $message';
}

String _required(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is String && value.isNotEmpty) return value;
  throw FormatException('scheduling: missing "$key"');
}

String? _optional(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;

DateTime _instant(Map<String, Object?> json, String key) {
  final value = json[key];
  final parsed = value is String ? DateTime.tryParse(value) : null;
  if (parsed == null) throw FormatException('scheduling: missing "$key"');
  return parsed;
}

DateTime? _optionalInstant(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;
