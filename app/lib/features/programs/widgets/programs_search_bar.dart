import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';

/// The reference's search + filter row: a wide search field on the right (RTL
/// start) and a compact filter button on the left.
///
/// Prototype scope: the search filters the visible cards client-side (no
/// backend); the filter button is a UI affordance.
class ProgramsSearchBar extends StatelessWidget {
  const ProgramsSearchBar({
    super.key,
    required this.onChanged,
    required this.onFilter,
  });

  final ValueChanged<String> onChanged;
  final VoidCallback onFilter;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          // A persistent accessible name that survives the field being filled
          // (the hint alone disappears once text is entered).
          child: Semantics(
            label: 'البحث عن برنامج',
            textField: true,
            child: TextField(
              onChanged: onChanged,
              textInputAction: TextInputAction.search,
              style: context.text.bodyMedium,
              decoration: InputDecoration(
                isDense: true,
                hintText: 'ابحث عن برنامج ..',
                prefixIcon: const Icon(Icons.search_rounded),
                filled: true,
                fillColor: context.colors.surfaceContainerLowest,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: Insets.md,
                  vertical: Insets.md,
                ),
                border: OutlineInputBorder(
                  borderRadius: Radii.brMd,
                  borderSide: BorderSide(color: context.colors.outlineVariant),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: Radii.brMd,
                  borderSide: BorderSide(color: context.colors.outlineVariant),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: Radii.brMd,
                  borderSide: BorderSide(
                    color: context.colors.primary,
                    width: 1.5,
                  ),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: Insets.sm),
        _FilterButton(onTap: onFilter),
      ],
    );
  }
}

class _FilterButton extends StatelessWidget {
  const _FilterButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: context.colors.surfaceContainerLowest,
      borderRadius: Radii.brMd,
      child: InkWell(
        onTap: onTap,
        borderRadius: Radii.brMd,
        child: Container(
          constraints: const BoxConstraints(minHeight: 52, minWidth: 48),
          padding: const EdgeInsets.symmetric(horizontal: Insets.md),
          decoration: BoxDecoration(
            borderRadius: Radii.brMd,
            border: Border.all(color: context.colors.outlineVariant),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.tune_rounded, size: 20, color: context.colors.primary),
              const SizedBox(width: Insets.xs),
              Text(
                'تصفية',
                style: context.text.labelLarge?.copyWith(
                  color: context.colors.primary,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
