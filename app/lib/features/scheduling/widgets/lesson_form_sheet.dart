import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/academic.dart';
import '../../../data/models/scheduling.dart';
import '../../../providers/app_providers.dart';
import '../scheduling_copy.dart';

/// A curated set of IANA zones for the picker. The server validates the chosen
/// zone regardless; this is only a convenience list (no fixed offsets — a
/// wall-clock schedule needs a named zone).
const List<String> kSchedulingTimezones = [
  'Asia/Riyadh',
  'Asia/Baghdad',
  'Asia/Kuwait',
  'Asia/Qatar',
  'Asia/Dubai',
  'Asia/Amman',
  'Africa/Cairo',
  'Europe/Istanbul',
  'Europe/London',
  'UTC',
];

class LessonFormValues {
  const LessonFormValues({
    required this.halaqaId,
    required this.title,
    required this.date,
    required this.time,
    required this.timezone,
    required this.clientRequestId,
  });

  /// Null when editing (a lesson's halaqa is fixed).
  final String? halaqaId;
  final String? title;
  final String date;
  final String time;
  final String timezone;
  /// Stable per form-open, so a retried create cannot duplicate.
  final String clientRequestId;
}

class LessonFormSpec {
  const LessonFormSpec({
    required this.title,
    required this.submitLabel,
    required this.successMessage,
    required this.chooseHalaqa,
    required this.onSubmit,
    this.initialTitle,
    this.initialDate,
    this.initialTime,
    this.initialTimezone,
  });

  final String title;
  final String submitLabel;
  final String successMessage;
  final bool chooseHalaqa;
  final String? initialTitle;
  final String? initialDate;
  final String? initialTime;
  final String? initialTimezone;
  final Future<void> Function(LessonFormValues values) onSubmit;
}

Future<void> showLessonForm(BuildContext context, {required LessonFormSpec spec}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => _LessonFormSheet(spec: spec),
  );
}

class _LessonFormSheet extends ConsumerStatefulWidget {
  const _LessonFormSheet({required this.spec});

  final LessonFormSpec spec;

  @override
  ConsumerState<_LessonFormSheet> createState() => _LessonFormSheetState();
}

class _LessonFormSheetState extends ConsumerState<_LessonFormSheet> {
  late final TextEditingController _title =
      TextEditingController(text: widget.spec.initialTitle ?? '');
  DateTime? _date;
  TimeOfDay? _time;
  late String _timezone = widget.spec.initialTimezone ?? kSchedulingTimezones.first;
  bool _submitting = false;

  // Halaqa cascade (create only).
  List<AcademicProgram>? _programs; // null while loading
  String? _programId;
  List<AcademicHalaqa>? _halaqat;
  bool _loadingHalaqat = false;
  String? _halaqaId;

  // One idempotency key per open form, so a retried submit cannot duplicate.
  final String _clientRequestId =
      'ui-${DateTime.now().microsecondsSinceEpoch}-${identityHashCode(Object())}';

  @override
  void initState() {
    super.initState();
    _date = _parseDate(widget.spec.initialDate);
    _time = _parseTime(widget.spec.initialTime);
    if (widget.spec.chooseHalaqa) {
      _loadPrograms();
    }
  }

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  Future<void> _loadPrograms() async {
    try {
      final catalogue = await ref.read(academicRepositoryProvider).catalogue();
      final programs = [for (final section in catalogue) ...section.programs];
      if (mounted) setState(() => _programs = programs);
    } on Object {
      if (mounted) setState(() => _programs = const []);
    }
  }

  Future<void> _loadHalaqat(String programId) async {
    setState(() {
      _loadingHalaqat = true;
      _halaqat = null;
      _halaqaId = null;
    });
    try {
      final detail = await ref.read(academicRepositoryProvider).program(programId);
      if (mounted) {
        setState(() {
          _halaqat = detail?.halaqat ?? const [];
          _loadingHalaqat = false;
        });
      }
    } on Object {
      if (mounted) {
        setState(() {
          _halaqat = const [];
          _loadingHalaqat = false;
        });
      }
    }
  }

  static DateTime? _parseDate(String? value) {
    if (value == null) return null;
    final parts = value.split('-');
    if (parts.length != 3) return null;
    final y = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    final d = int.tryParse(parts[2]);
    if (y == null || m == null || d == null) return null;
    return DateTime(y, m, d);
  }

  static TimeOfDay? _parseTime(String? value) {
    if (value == null) return null;
    final parts = value.split(':');
    if (parts.length != 2) return null;
    final h = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    if (h == null || m == null) return null;
    return TimeOfDay(hour: h, minute: m);
  }

  String _fmtDate(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  String _fmtTime(TimeOfDay t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  bool get _canSubmit =>
      !_submitting &&
      _date != null &&
      _time != null &&
      (!widget.spec.chooseHalaqa || _halaqaId != null);

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _date ?? now,
      firstDate: DateTime(now.year, now.month, now.day),
      lastDate: DateTime(now.year + 2, now.month, now.day),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(context: context, initialTime: _time ?? TimeOfDay.now());
    if (picked != null) setState(() => _time = picked);
  }

  Future<void> _submit() async {
    if (!_canSubmit) return;
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    setState(() => _submitting = true);
    final title = _title.text.trim();
    try {
      await widget.spec.onSubmit(
        LessonFormValues(
          halaqaId: _halaqaId,
          title: title.isEmpty ? null : title,
          date: _fmtDate(_date!),
          time: _fmtTime(_time!),
          timezone: _timezone,
          clientRequestId: _clientRequestId,
        ),
      );
    } on SchedulingException catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      messenger.toast(SchedulingCopy.changeFailed(error.code));
      return;
    }
    if (!mounted) return;
    messenger.toast(widget.spec.successMessage);
    if (navigator.canPop()) navigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    return SafeArea(
      child: Padding(
        padding: EdgeInsetsDirectional.fromSTEB(Insets.lg, 0, Insets.lg, Insets.lg + bottomInset),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(widget.spec.title, style: context.text.titleLarge),
              const SizedBox(height: Insets.lg),
              if (widget.spec.chooseHalaqa) ...[
                _programField(),
                const SizedBox(height: Insets.md),
                _halaqaField(),
                const SizedBox(height: Insets.md),
              ],
              TextField(
                key: const Key('lesson-form-title'),
                controller: _title,
                enabled: !_submitting,
                decoration: const InputDecoration(labelText: SchedulingCopy.lessonTitle),
              ),
              const SizedBox(height: Insets.md),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      key: const Key('lesson-form-date'),
                      onPressed: _submitting ? null : _pickDate,
                      icon: const Icon(Icons.event_outlined),
                      label: Text(_date == null ? SchedulingCopy.pickDate : _fmtDate(_date!)),
                    ),
                  ),
                  const SizedBox(width: Insets.sm),
                  Expanded(
                    child: OutlinedButton.icon(
                      key: const Key('lesson-form-time'),
                      onPressed: _submitting ? null : _pickTime,
                      icon: const Icon(Icons.schedule_outlined),
                      label: Text(_time == null ? SchedulingCopy.pickTime : _fmtTime(_time!)),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: Insets.md),
              DropdownButtonFormField<String>(
                key: const Key('lesson-form-timezone'),
                initialValue: _timezone,
                decoration: const InputDecoration(labelText: SchedulingCopy.timezone),
                items: [
                  for (final zone in {_timezone, ...kSchedulingTimezones})
                    DropdownMenuItem(value: zone, child: Text(zone)),
                ],
                onChanged: _submitting ? null : (value) => setState(() => _timezone = value ?? _timezone),
              ),
              const SizedBox(height: Insets.xs),
              Text(SchedulingCopy.timezoneHint, style: context.text.bodySmall),
              const SizedBox(height: Insets.lg),
              FilledButton(
                key: const Key('lesson-form-submit'),
                onPressed: _canSubmit ? _submit : null,
                child: _submitting
                    ? const SizedBox(
                        width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(widget.spec.submitLabel),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _programField() {
    final programs = _programs;
    if (programs == null) {
      return const LinearProgressIndicator();
    }
    return DropdownButtonFormField<String>(
      key: const Key('lesson-form-program'),
      initialValue: _programId,
      decoration: const InputDecoration(labelText: SchedulingCopy.program),
      hint: const Text(SchedulingCopy.pickProgram),
      items: [
        for (final program in programs)
          DropdownMenuItem(value: program.id, child: Text(program.name)),
      ],
      onChanged: _submitting
          ? null
          : (value) {
              if (value == null) return;
              setState(() => _programId = value);
              _loadHalaqat(value);
            },
    );
  }

  Widget _halaqaField() {
    if (_loadingHalaqat) return const LinearProgressIndicator();
    final halaqat = _halaqat ?? const <AcademicHalaqa>[];
    return DropdownButtonFormField<String>(
      key: const Key('lesson-form-halaqa'),
      initialValue: _halaqaId,
      decoration: const InputDecoration(labelText: SchedulingCopy.halaqa),
      hint: const Text(SchedulingCopy.pickHalaqa),
      items: [
        for (final halaqa in halaqat)
          DropdownMenuItem(value: halaqa.id, child: Text(halaqa.name)),
      ],
      onChanged: (_programId == null || _submitting)
          ? null
          : (value) => setState(() => _halaqaId = value),
    );
  }
}
