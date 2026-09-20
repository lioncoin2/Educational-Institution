import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.message,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String title;
  final String? message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(
        vertical: Insets.huge,
        horizontal: Insets.xxl,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 72,
            height: 72,
            decoration: BoxDecoration(
              color: context.colors.primaryContainer,
              shape: BoxShape.circle,
            ),
            child: Icon(icon, size: 32, color: context.colors.onPrimaryContainer),
          ),
          const SizedBox(height: Insets.lg),
          Text(
            title,
            textAlign: TextAlign.center,
            style: context.text.titleMedium,
          ),
          if (message != null) ...[
            const SizedBox(height: Insets.sm),
            Text(
              message!,
              textAlign: TextAlign.center,
              style: context.text.bodyMedium,
            ),
          ],
          if (actionLabel != null && onAction != null) ...[
            const SizedBox(height: Insets.lg),
            FilledButton(onPressed: onAction, child: Text(actionLabel!)),
          ],
        ],
      ),
    );
  }
}
