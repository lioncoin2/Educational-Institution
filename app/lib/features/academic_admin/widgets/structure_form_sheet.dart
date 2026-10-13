import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../data/models/academic.dart';
import '../academic_admin_copy.dart';

/// The real section kinds a person may choose from — never [SectionKind.unknown],
/// which exists only to carry a value this app has not heard of.
const _selectableKinds = <SectionKind>[
  SectionKind.progressive,
  SectionKind.special,
  SectionKind.accompanying,
];

/// What one create/edit submission carries. [code] and [kind] are present only
/// where the form shows them; [description] is null when blank (on edit that
/// means "clear it").
class StructureFormValues {
  const StructureFormValues({
    this.code,
    required this.name,
    required this.order,
    this.kind,
    this.description,
  });

  final String? code;
  final String name;
  final int order;
  final SectionKind? kind;
  final String? description;
}

/// How one run of the sheet is shaped: its title, which fields it shows, the
/// values an edit starts from, and the single write it performs. [onSubmit]
/// calls the matching controller method; it throws [AcademicException] when the
/// server refuses, and the sheet says so without closing.
class StructureFormSpec {
  const StructureFormSpec({
    required this.title,
    required this.submitLabel,
    required this.successMessage,
    required this.onSubmit,
    this.showCode = false,
    this.showKind = false,
    this.showDescription = false,
    this.initialName,
    this.initialOrder,
    this.initialKind,
    this.initialDescription,
  });

  final String title;
  final String submitLabel;
  final String successMessage;
  final Future<void> Function(StructureFormValues values) onSubmit;

  /// Code is set once, on create, and never edited (the server keeps it stable).
  final bool showCode;

  /// Only a section carries a kind, and only on create.
  final bool showKind;

  /// Sections and programs carry a description; halaqat do not.
  final bool showDescription;

  final String? initialName;
  final int? initialOrder;
  final SectionKind? initialKind;
  final String? initialDescription;
}

/// Opens the create/edit sheet. The caller shows the entry only to a holder of
/// `academic.manage`; the server re-authorises the write on the request.
Future<void> showStructureForm(
  BuildContext context, {
  required StructureFormSpec spec,
}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => _StructureFormSheet(spec: spec),
  );
}

class _StructureFormSheet extends ConsumerStatefulWidget {
  const _StructureFormSheet({required this.spec});

  final StructureFormSpec spec;

  @override
  ConsumerState<_StructureFormSheet> createState() =>
      _StructureFormSheetState();
}

class _StructureFormSheetState extends ConsumerState<_StructureFormSheet> {
  late final TextEditingController _code;
  late final TextEditingController _name;
  late final TextEditingController _order;
  late final TextEditingController _description;
  SectionKind? _kind;
  bool _submitting = false;

  StructureFormSpec get _spec => widget.spec;

  @override
  void initState() {
    super.initState();
    _code = TextEditingController();
    _name = TextEditingController(text: _spec.initialName ?? '');
    _order = TextEditingController(text: _spec.initialOrder?.toString() ?? '');
    _description = TextEditingController(text: _spec.initialDescription ?? '');
    _kind = _spec.initialKind;
  }

  @override
  void dispose() {
    _code.dispose();
    _name.dispose();
    _order.dispose();
    _description.dispose();
    super.dispose();
  }

  int? get _parsedOrder {
    final value = int.tryParse(_order.text.trim());
    return (value == null || value < 1) ? null : value;
  }

  bool get _canSubmit =>
      !_submitting &&
      _name.text.trim().isNotEmpty &&
      _parsedOrder != null &&
      (!_spec.showCode || _code.text.trim().isNotEmpty) &&
      (!_spec.showKind || _kind != null);

  Future<void> _submit() async {
    if (!_canSubmit) return;
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    final description = _description.text.trim();
    setState(() => _submitting = true);
    try {
      await _spec.onSubmit(
        StructureFormValues(
          code: _spec.showCode ? _code.text.trim() : null,
          name: _name.text.trim(),
          order: _parsedOrder!,
          kind: _spec.showKind ? _kind : null,
          description: _spec.showDescription && description.isNotEmpty
              ? description
              : null,
        ),
      );
    } on AcademicException catch (error) {
      if (!mounted) return;
      setState(() => _submitting = false);
      messenger.toast(AcademicAdminCopy.changeFailed(error.code));
      return;
    }
    if (!mounted) return;
    messenger.toast(_spec.successMessage);
    if (navigator.canPop()) navigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final orderInvalid = _order.text.trim().isNotEmpty && _parsedOrder == null;
    return SafeArea(
      child: Padding(
        padding: EdgeInsetsDirectional.fromSTEB(
          Insets.lg,
          0,
          Insets.lg,
          Insets.lg + bottomInset,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(_spec.title, style: context.text.titleMedium),
              const SizedBox(height: Insets.md),
              if (_spec.showCode) ...[
                TextField(
                  key: const Key('structure-form-code'),
                  controller: _code,
                  autofocus: true,
                  enabled: !_submitting,
                  autocorrect: false,
                  textInputAction: TextInputAction.next,
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(
                    labelText: AcademicAdminCopy.codeLabel,
                    hintText: AcademicAdminCopy.codeHint,
                  ),
                ),
                const SizedBox(height: Insets.md),
              ],
              TextField(
                key: const Key('structure-form-name'),
                controller: _name,
                autofocus: !_spec.showCode,
                enabled: !_submitting,
                textInputAction: TextInputAction.next,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  labelText: AcademicAdminCopy.nameLabel,
                ),
              ),
              const SizedBox(height: Insets.md),
              TextField(
                key: const Key('structure-form-order'),
                controller: _order,
                enabled: !_submitting,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                textInputAction: TextInputAction.next,
                onChanged: (_) => setState(() {}),
                decoration: InputDecoration(
                  labelText: AcademicAdminCopy.orderLabel,
                  errorText: orderInvalid
                      ? AcademicAdminCopy.changeFailed('academic.order_invalid')
                      : null,
                ),
              ),
              if (_spec.showKind) ...[
                const SizedBox(height: Insets.md),
                DropdownButtonFormField<SectionKind>(
                  key: const Key('structure-form-kind'),
                  initialValue: _kind,
                  decoration: const InputDecoration(
                    labelText: AcademicAdminCopy.kindLabel,
                  ),
                  items: [
                    for (final kind in _selectableKinds)
                      DropdownMenuItem(
                        value: kind,
                        child: Text(AcademicAdminCopy.kind(kind)),
                      ),
                  ],
                  onChanged: _submitting
                      ? null
                      : (value) => setState(() => _kind = value),
                ),
              ],
              if (_spec.showDescription) ...[
                const SizedBox(height: Insets.md),
                TextField(
                  key: const Key('structure-form-description'),
                  controller: _description,
                  enabled: !_submitting,
                  minLines: 1,
                  maxLines: 3,
                  textInputAction: TextInputAction.newline,
                  decoration: const InputDecoration(
                    labelText: AcademicAdminCopy.descriptionLabel,
                  ),
                ),
              ],
              const SizedBox(height: Insets.lg),
              FilledButton(
                key: const Key('structure-form-submit'),
                onPressed: _canSubmit ? _submit : null,
                child: _submitting
                    ? const ExcludeSemantics(
                        child: SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    : Text(_spec.submitLabel),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
