import 'package:flutter/material.dart';

import '../../../core/theme/app_tokens.dart';
import '../../../data/models/institution.dart';
import '../../home/widgets/home_palette.dart';
import 'program_field_card.dart';

/// Decoration for one field card — an icon, a prototype photo and a tint.
/// Keyed by the real study-field id so the presentation layer carries no data.
class _FieldStyle {
  const _FieldStyle(this.icon, this.asset, this.tone);
  final IconData icon;
  final String asset;
  final HomeTileTone tone;
}

/// The reference's program grid: two compact cards per row (three on tablet,
/// four on desktop), one per real study field.
///
/// The cards are the institution's six real تعليم-fields (profile page 5).
/// Photos are replaceable prototype assets under `assets/images/`; each card
/// falls back to a coloured panel until its photo is supplied.
class ProgramsGrid extends StatelessWidget {
  const ProgramsGrid({super.key, required this.fields, required this.onOpen});

  final List<StudyField> fields;
  final void Function(StudyField field) onOpen;

  // Photos are named for our own fields (not the reference categories) so the
  // mapping is self-documenting. Drop a file at the path to replace a panel.
  static const _styles = <String, _FieldStyle>{
    'f1': _FieldStyle(Icons.menu_book_rounded,
        'assets/images/program_quran.jpg', HomeTileTone.mint),
    'f2': _FieldStyle(Icons.account_balance_rounded,
        'assets/images/program_sharia.jpg', HomeTileTone.peach),
    'f3': _FieldStyle(Icons.record_voice_over_rounded,
        'assets/images/program_tajweed.jpg', HomeTileTone.sky),
    'f4': _FieldStyle(Icons.translate_rounded,
        'assets/images/program_language.jpg', HomeTileTone.lavender),
    'f5': _FieldStyle(Icons.auto_stories_rounded,
        'assets/images/program_mutun.jpg', HomeTileTone.mint),
    'f6': _FieldStyle(Icons.public_rounded,
        'assets/images/program_international.jpg', HomeTileTone.sky),
  };

  static const _fallback = _FieldStyle(Icons.school_rounded,
      'assets/images/program_quran.jpg', HomeTileTone.mint);

  static const _gap = Insets.md;

  int _columns(double width) {
    if (width >= 1024) return 4;
    if (width >= 600) return 3;
    return 2;
  }

  @override
  Widget build(BuildContext context) {
    if (fields.isEmpty) return const SizedBox.shrink();

    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = _columns(constraints.maxWidth);
        final cardW = (constraints.maxWidth - _gap * (columns - 1)) / columns;

        final rows = <List<StudyField>>[];
        for (var i = 0; i < fields.length; i += columns) {
          rows.add(fields.sublist(
              i, (i + columns).clamp(0, fields.length)));
        }

        return Column(
          children: [
            for (var r = 0; r < rows.length; r++) ...[
              if (r > 0) const SizedBox(height: _gap),
              IntrinsicHeight(
                child: Row(
                  mainAxisAlignment: rows[r].length == columns
                      ? MainAxisAlignment.start
                      : MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (var col = 0; col < rows[r].length; col++) ...[
                      if (col > 0) const SizedBox(width: _gap),
                      SizedBox(
                        width: cardW,
                        child: _card(context, rows[r][col]),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ],
        );
      },
    );
  }

  Widget _card(BuildContext context, StudyField field) {
    final style = _styles[field.id] ?? _fallback;
    return ProgramFieldCard(
      title: field.name,
      icon: style.icon,
      assetPath: style.asset,
      tone: style.tone,
      onTap: () => onOpen(field),
    );
  }
}
