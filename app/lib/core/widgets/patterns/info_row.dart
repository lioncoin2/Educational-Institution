import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

/// Label/value row used in details screens.
class InfoRow extends StatelessWidget {
  const InfoRow({
    super.key,
    required this.icon,
    required this.label,
    required this.value,
    this.valueStyle,
  });

  final IconData icon;
  final String label;
  final String value;
  final TextStyle? valueStyle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: context.colors.primary),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: context.text.labelSmall),
                const SizedBox(height: 2),
                Text(value, style: valueStyle ?? context.text.bodyMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Bulleted list with the plum marker used across detail screens.
class BulletList extends StatelessWidget {
  const BulletList({super.key, required this.items, this.dense = false});

  final List<String> items;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final item in items)
          Padding(
            padding: EdgeInsets.only(bottom: dense ? Insets.sm : Insets.md),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  margin: const EdgeInsets.only(top: 7),
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: context.colors.primary,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: Insets.md),
                Expanded(child: Text(item, style: context.text.bodyMedium)),
              ],
            ),
          ),
      ],
    );
  }
}
