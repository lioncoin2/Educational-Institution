/// The Owner Command Center — the server's read-model widgets
/// (`GET /reporting/command-center`).
///
/// READ-ONLY and defensive: every widget and metric is the server's own fact,
/// parsed so an unknown shape yields nothing rather than a crash (a newer
/// server never breaks an older app). Nothing here computes a figure — the
/// screen shows only what the server returned, and an empty set is a legitimate
/// answer, not an error.
library;

import 'data_origin.dart';

/// One figure in a widget: a stable [key], a human [label], and its [value].
class CommandMetric {
  const CommandMetric({required this.key, required this.label, required this.value});

  factory CommandMetric.fromJson(Map<String, Object?> json) => CommandMetric(
    key: json['key'] is String ? json['key']! as String : '',
    label: json['label'] is String ? json['label']! as String : '',
    value: json['value'] is num ? (json['value']! as num).toInt() : 0,
  );

  final String key;
  final String label;
  final int value;
}

/// One command-center widget: the server's [id], its [category] and [title]
/// (presentation the server owns), and the [metrics] it resolved.
class CommandWidget {
  const CommandWidget({
    required this.id,
    required this.category,
    required this.title,
    required this.metrics,
  });

  factory CommandWidget.fromJson(Map<String, Object?> json) {
    final payload = json['payload'];
    final rawMetrics = payload is Map ? payload['metrics'] : null;
    return CommandWidget(
      id: json['id'] is String ? json['id']! as String : '',
      category: json['category'] is String ? json['category']! as String : '',
      title: json['title'] is String ? json['title']! as String : '',
      metrics: rawMetrics is List
          ? [
              for (final metric in rawMetrics)
                if (metric is Map) CommandMetric.fromJson(metric.cast<String, Object?>()),
            ]
          : const [],
    );
  }

  final String id;
  final String category;
  final String title;
  final List<CommandMetric> metrics;
}

/// The command center: the widgets the viewer may see (the server has already
/// filtered to what they are authorized for), each with its current facts.
///
/// One quick action: the server's stable [id] (a client maps it to a route) and
/// its human [title]. The server lists only actions the viewer may perform; the
/// operation re-authorizes when invoked, so this is a shortcut, never a gate.
class CommandAction {
  const CommandAction({required this.id, required this.title});

  factory CommandAction.fromJson(Map<String, Object?> json) => CommandAction(
    id: json['id'] is String ? json['id']! as String : '',
    title: json['title'] is String ? json['title']! as String : '',
  );

  final String id;
  final String title;
}

/// The command center: the widgets the viewer may see (the server has already
/// filtered to what they are authorized for), each with its current facts, plus
/// the quick [actions] they may perform.
class CommandCenter implements Sourced {
  const CommandCenter({
    required this.widgets,
    this.actions = const [],
    this.origin = DataOrigin.records,
  });

  factory CommandCenter.fromJson(
    Map<String, Object?> json, {
    DataOrigin origin = DataOrigin.records,
  }) {
    final widgets = json['widgets'];
    final actions = json['actions'];
    return CommandCenter(
      widgets: widgets is List
          ? [
              for (final widget in widgets)
                if (widget is Map) CommandWidget.fromJson(widget.cast<String, Object?>()),
            ]
          : const [],
      actions: actions is List
          ? [
              for (final action in actions)
                if (action is Map) CommandAction.fromJson(action.cast<String, Object?>()),
            ]
          : const [],
      origin: origin,
    );
  }

  final List<CommandWidget> widgets;
  final List<CommandAction> actions;

  @override
  final DataOrigin origin;

  bool get isEmpty => widgets.isEmpty && actions.isEmpty;
}

/// A refusal from `/reporting`, with the server's stable code.
class ReportingException implements Exception {
  const ReportingException(this.code, this.message);

  final String code;
  final String message;

  bool get isNetwork => code == 'network.unreachable';
  bool get needsSignIn => code == 'identity.authentication_required';
  bool get isForbidden => code == 'identity.permission_denied';
  bool get isUnavailable => code == 'unavailable';

  @override
  String toString() => 'ReportingException($code): $message';
}
