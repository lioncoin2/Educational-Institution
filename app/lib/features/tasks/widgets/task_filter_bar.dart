import 'package:flutter/material.dart';

import '../../../core/theme/app_tokens.dart';
import '../../../data/models/tasks/tasks.dart';
import '../copy/tasks_copy.dart';
import '../copy/tasks_labels.dart';
import 'task_format.dart';

/// The common search and filters (roadmap §12–§15): text, audience, kind,
/// state, report status and a date range. Each screen shows the ones it uses;
/// a change is reported at once and the caller re-reads from the server.
class TaskFilterBar extends StatefulWidget {
  const TaskFilterBar({
    super.key,
    required this.filter,
    required this.onChanged,
    this.showSearch = true,
    this.showState = true,
    this.showReportStatus = false,
  });

  final TaskFilter filter;
  final ValueChanged<TaskFilter> onChanged;
  final bool showSearch;
  final bool showState;
  final bool showReportStatus;

  @override
  State<TaskFilterBar> createState() => _TaskFilterBarState();
}

class _TaskFilterBarState extends State<TaskFilterBar> {
  late final _search = TextEditingController(text: widget.filter.text ?? '');

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  TaskFilter get _filter => widget.filter;

  void _change(TaskFilter next) {
    if (next != _filter) widget.onChanged(next);
  }

  Future<void> _pickDates() async {
    final now = DateTime.now();
    final range = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 5),
      lastDate: DateTime(now.year + 1, 12, 31),
      initialDateRange: _filter.from != null && _filter.to != null
          ? DateTimeRange(start: _filter.from!, end: _filter.to!.subtract(const Duration(days: 1)))
          : null,
    );
    if (range == null) return;
    // `to` is exclusive: the whole last day is included.
    _change(
      _filter.copyWith(from: () => range.start, to: () => range.end.add(const Duration(days: 1))),
    );
  }

  @override
  Widget build(BuildContext context) {
    final dates = _filter.from == null
        ? TasksCopy.fromDate
        : '${TaskFormat.when(_filter.from!).split(' ').first} – '
              '${TaskFormat.when(_filter.to!.subtract(const Duration(days: 1))).split(' ').first}';
    return Padding(
      padding: const EdgeInsets.only(bottom: Insets.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (widget.showSearch)
            TextField(
              key: const Key('tasks-search'),
              controller: _search,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                hintText: TasksCopy.search,
                prefixIcon: const Icon(Icons.search),
                border: const OutlineInputBorder(),
                isDense: true,
                suffixIcon: _search.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: TasksCopy.clearFilters,
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _search.clear();
                          _change(_filter.copyWith(text: () => null));
                        },
                      ),
              ),
              onSubmitted: (text) => _change(_filter.copyWith(text: () => text.trim())),
            ),
          const SizedBox(height: Insets.sm),
          Wrap(
            spacing: Insets.sm,
            runSpacing: Insets.sm,
            children: [
              _Choice<TaskAudience>(
                key: const Key('tasks-filter-audience'),
                anyLabel: TasksCopy.anyAudience,
                value: _filter.audience,
                options: TaskAudience.selectable,
                labelOf: TasksLabels.audience,
                onChanged: (v) => _change(_filter.copyWith(audience: () => v)),
              ),
              _Choice<TaskKind>(
                key: const Key('tasks-filter-kind'),
                anyLabel: TasksCopy.anyKind,
                value: _filter.kind,
                options: TaskKind.selectable,
                labelOf: TasksLabels.kind,
                onChanged: (v) => _change(_filter.copyWith(kind: () => v)),
              ),
              if (widget.showState)
                _Choice<TaskState>(
                  key: const Key('tasks-filter-state'),
                  anyLabel: TasksCopy.anyState,
                  value: _filter.state,
                  options: TaskState.selectable,
                  labelOf: TasksLabels.state,
                  onChanged: (v) => _change(_filter.copyWith(state: () => v)),
                ),
              if (widget.showReportStatus)
                _Choice<ReportStatus>(
                  key: const Key('tasks-filter-report-status'),
                  anyLabel: TasksCopy.anyReportStatus,
                  value: _filter.reportStatus,
                  options: ReportStatus.selectable,
                  labelOf: TasksLabels.report,
                  onChanged: (v) => _change(_filter.copyWith(reportStatus: () => v)),
                ),
              ActionChip(
                key: const Key('tasks-filter-dates'),
                avatar: const Icon(Icons.date_range_outlined, size: 18),
                label: Text(dates),
                onPressed: _pickDates,
              ),
              if (!_filter.isEmpty)
                ActionChip(
                  key: const Key('tasks-filter-clear'),
                  avatar: const Icon(Icons.filter_alt_off_outlined, size: 18),
                  label: const Text(TasksCopy.clearFilters),
                  onPressed: () {
                    _search.clear();
                    _change(TaskFilter.none);
                  },
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// One filter as a menu chip: "any" or one value.
class _Choice<T> extends StatelessWidget {
  const _Choice({
    super.key,
    required this.anyLabel,
    required this.value,
    required this.options,
    required this.labelOf,
    required this.onChanged,
  });

  final String anyLabel;
  final T? value;
  final List<T> options;
  final String Function(T) labelOf;
  final ValueChanged<T?> onChanged;

  @override
  Widget build(BuildContext context) {
    final current = value;
    // A menu cannot answer null (that reads as dismissal): wrap the choice.
    return PopupMenuButton<({T? value})>(
      tooltip: anyLabel,
      onSelected: (picked) => onChanged(picked.value),
      itemBuilder: (context) => [
        PopupMenuItem(value: (value: null), child: Text(anyLabel)),
        for (final option in options)
          PopupMenuItem(value: (value: option), child: Text(labelOf(option))),
      ],
      child: Chip(
        avatar: const Icon(Icons.arrow_drop_down, size: 18),
        label: Text(current == null ? anyLabel : labelOf(current)),
      ),
    );
  }
}
