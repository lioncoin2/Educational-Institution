import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

/// Rounded linear progress with an optional caption above it.
class AppProgressBar extends StatelessWidget {
  const AppProgressBar({
    super.key,
    required this.value,
    this.label,
    this.trailingLabel,
    this.color,
    this.height = 8,
  });

  final double value;
  final String? label;
  final String? trailingLabel;
  final Color? color;
  final double height;

  @override
  Widget build(BuildContext context) {
    final clamped = value.clamp(0.0, 1.0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (label != null || trailingLabel != null) ...[
          Row(
            children: [
              if (label != null)
                Expanded(child: Text(label!, style: context.text.labelMedium)),
              if (trailingLabel != null)
                Text(
                  trailingLabel!,
                  style: context.text.labelMedium?.copyWith(
                    color: context.colors.primary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
            ],
          ),
          const SizedBox(height: Insets.sm),
        ],
        ClipRRect(
          borderRadius: Radii.pill,
          child: TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: clamped),
            duration: Motion.progress,
            curve: Curves.easeInOut,
            builder: (context, v, _) => LinearProgressIndicator(
              value: v,
              minHeight: height,
              color: color ?? context.colors.primary,
              backgroundColor: context.colors.surfaceContainerHighest,
            ),
          ),
        ),
      ],
    );
  }
}

/// Circular progress used for the big "overall" figure on Progress and Home.
class AppProgressRing extends StatelessWidget {
  const AppProgressRing({
    super.key,
    required this.value,
    required this.centerTop,
    this.centerBottom,
    this.size = 128,
    this.strokeWidth = 12,
    this.color,
  });

  final double value;
  final String centerTop;
  final String? centerBottom;
  final double size;
  final double strokeWidth;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: TweenAnimationBuilder<double>(
        tween: Tween(begin: 0, end: value.clamp(0.0, 1.0)),
        duration: Motion.progress,
        curve: Curves.easeInOut,
        builder: (context, v, _) => Stack(
          alignment: Alignment.center,
          children: [
            SizedBox.expand(
              child: CircularProgressIndicator(
                value: v,
                strokeWidth: strokeWidth,
                strokeCap: StrokeCap.round,
                color: color ?? context.colors.primary,
                backgroundColor: context.colors.surfaceContainerHighest,
              ),
            ),
            Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  centerTop,
                  style: context.text.headlineMedium?.copyWith(
                    color: color ?? context.colors.primary,
                  ),
                ),
                if (centerBottom != null)
                  Text(centerBottom!, style: context.text.labelSmall),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
