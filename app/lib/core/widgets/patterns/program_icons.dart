import 'package:flutter/material.dart';

/// Maps the string keys used in the data layer to icons, so the data layer
/// never imports Flutter.
IconData programIcon(String name) => switch (name) {
      'literacy' => Icons.abc_rounded,
      'letters' => Icons.text_fields_rounded,
      'tajweed' => Icons.record_voice_over_outlined,
      'spelling' => Icons.spellcheck_rounded,
      'kids' => Icons.child_care_rounded,
      'languages' => Icons.translate_rounded,
      'hifz' => Icons.location_city_rounded,
      'nahw' => Icons.rule_rounded,
      'maqari' => Icons.groups_2_outlined,
      'mutun' => Icons.auto_stories_outlined,
      _ => Icons.menu_book_rounded,
    };
