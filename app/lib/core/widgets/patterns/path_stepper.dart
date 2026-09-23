import 'package:flutter/material.dart';

import '../../../data/models/learning.dart';
import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

/// The signature component of the app: the graded ladder of the five
/// departments from page 6 of the profile, with the learner's position on it.
///
/// The rungs and their halaqat counts are real. In the demo the position is
/// mock; against the server it is the learner's enrollment, and a rung with
/// no recorded progress shows no bar and no "X of Y".
class PathStepper extends StatelessWidget {
  const PathStepper({
    super.key,
    required this.steps,
    this.onStepTap,
    this.compact = false,
  });

  final List<PathStep> steps;
  final void Function(PathStep step)? onStepTap;

  /// Compact renders a short horizontal strip for the home screen.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    if (compact) return _CompactStrip(steps: steps, onStepTap: onStepTap);
    return Column(
      children: [
        for (var i = 0; i < steps.length; i++)
          _StepRow(
            step: steps[i],
            isLast: i == steps.length - 1,
            onTap: onStepTap == null ? null : () => onStepTap!(steps[i]),
          ),
      ],
    );
  }
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.step, required this.isLast, this.onTap});

  final PathStep step;
  final bool isLast;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final visual = _StepVisual.of(context, step.state);

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Rail: marker + connector.
          SizedBox(
            width: 44,
            child: Column(
              children: [
                _Marker(step: step, visual: visual),
                if (!isLast)
                  Expanded(
                    child: Container(
                      width: 3,
                      margin: const EdgeInsets.symmetric(vertical: Insets.xs),
                      decoration: BoxDecoration(
                        color: step.state == ProgressState.completed
                            ? context.colors.primary
                            : context.colors.outlineVariant,
                        borderRadius: Radii.pill,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: isLast ? 0 : Insets.lg),
              child: Material(
                color: visual.background,
                borderRadius: Radii.brLg,
                child: InkWell(
                  onTap: step.state == ProgressState.locked ? null : onTap,
                  borderRadius: Radii.brLg,
                  child: Padding(
                    padding: const EdgeInsets.all(Insets.lg),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                step.name,
                                style: context.text.titleMedium?.copyWith(
                                  color: visual.foreground,
                                ),
                              ),
                            ),
                            if (step.state != ProgressState.locked && onTap != null)
                              Icon(
                                Icons.chevron_right_rounded,
                                size: 20,
                                color: visual.foreground.withValues(alpha: 0.7),
                              ),
                          ],
                        ),
                        const SizedBox(height: Insets.sm),
                        Text(
                          visual.stateLabel.isEmpty
                              ? '${step.halaqatCount} حلقات'
                              : '${step.halaqatCount} حلقات · ${visual.stateLabel}',
                          style: context.text.labelMedium
                              ?.copyWith(color: visual.foreground.withValues(alpha: 0.85)),
                        ),
                        if (step.state != ProgressState.locked &&
                            step.ratio != null) ...[
                          const SizedBox(height: Insets.md),
                          ClipRRect(
                            borderRadius: Radii.pill,
                            child: LinearProgressIndicator(
                              value: step.ratio!,
                              minHeight: 6,
                              color: visual.foreground,
                              backgroundColor:
                                  visual.foreground.withValues(alpha: 0.2),
                            ),
                          ),
                          const SizedBox(height: Insets.sm),
                          Text(
                            'أتممتِ ${step.completedHalaqat} من ${step.halaqatCount}',
                            style: context.text.labelSmall?.copyWith(
                              color: visual.foreground.withValues(alpha: 0.85),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Marker extends StatelessWidget {
  const _Marker({required this.step, required this.visual});

  final PathStep step;
  final _StepVisual visual;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        color: visual.markerBackground,
        shape: BoxShape.circle,
        border: Border.all(color: visual.markerBorder, width: 2),
      ),
      alignment: Alignment.center,
      child: switch (step.state) {
        ProgressState.completed =>
          Icon(Icons.check_rounded, size: 22, color: visual.markerForeground),
        ProgressState.locked =>
          Icon(Icons.lock_outline_rounded, size: 18, color: visual.markerForeground),
        _ => Text(
            '${step.order}',
            style: context.text.titleMedium
                ?.copyWith(color: visual.markerForeground, fontWeight: FontWeight.w800),
          ),
      },
    );
  }
}

class _CompactStrip extends StatelessWidget {
  const _CompactStrip({required this.steps, this.onStepTap});

  final List<PathStep> steps;
  final void Function(PathStep step)? onStepTap;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 0; i < steps.length; i++) ...[
          Expanded(
            child: Semantics(
              label: _StepVisual.label(steps[i].state).isEmpty
                  ? steps[i].name
                  : '${steps[i].name} — ${_StepVisual.label(steps[i].state)}',
              button: onStepTap != null,
              child: GestureDetector(
                onTap: steps[i].state == ProgressState.locked || onStepTap == null
                    ? null
                    : () => onStepTap!(steps[i]),
                child: Column(
                  children: [
                    Container(
                      height: 6,
                      decoration: BoxDecoration(
                        color: switch (steps[i].state) {
                          ProgressState.completed => context.colors.primary,
                          ProgressState.current => context.colors.secondary,
                          _ => context.colors.outlineVariant,
                        },
                        borderRadius: Radii.pill,
                      ),
                    ),
                    const SizedBox(height: Insets.sm),
                    Text(
                      '${steps[i].order}',
                      style: context.text.labelSmall?.copyWith(
                        fontWeight: steps[i].state == ProgressState.current
                            ? FontWeight.w800
                            : FontWeight.w500,
                        color: steps[i].state == ProgressState.current
                            ? context.colors.primary
                            : context.colors.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          if (i != steps.length - 1) const SizedBox(width: Insets.sm),
        ],
      ],
    );
  }
}

class _StepVisual {
  const _StepVisual({
    required this.background,
    required this.foreground,
    required this.markerBackground,
    required this.markerBorder,
    required this.markerForeground,
    required this.stateLabel,
  });

  final Color background;
  final Color foreground;
  final Color markerBackground;
  final Color markerBorder;
  final Color markerForeground;
  final String stateLabel;

  static String label(ProgressState state) => switch (state) {
        ProgressState.completed => 'مكتمل',
        ProgressState.current => 'الحالي',
        ProgressState.available => 'متاح',
        ProgressState.locked => 'يفتح بعد إتمام ما قبله',
        // Nothing recorded, so nothing is claimed.
        ProgressState.none => '',
      };

  static _StepVisual of(BuildContext context, ProgressState state) {
    final c = context.colors;
    return switch (state) {
      ProgressState.current => _StepVisual(
          background: c.primary,
          foreground: c.onPrimary,
          markerBackground: c.primary,
          markerBorder: c.primary,
          markerForeground: c.onPrimary,
          stateLabel: label(state),
        ),
      ProgressState.completed => _StepVisual(
          background: c.primaryContainer,
          foreground: c.onPrimaryContainer,
          markerBackground: c.primaryContainer,
          markerBorder: c.primary,
          markerForeground: c.onPrimaryContainer,
          stateLabel: label(state),
        ),
      ProgressState.available || ProgressState.none => _StepVisual(
          background: c.surfaceContainerLow,
          foreground: c.onSurface,
          markerBackground: c.surfaceContainerLow,
          markerBorder: c.outline,
          markerForeground: c.onSurfaceVariant,
          stateLabel: label(state),
        ),
      ProgressState.locked => _StepVisual(
          background: c.surfaceContainerLow,
          foreground: c.onSurfaceVariant,
          markerBackground: c.surfaceContainerLow,
          markerBorder: c.outlineVariant,
          markerForeground: c.onSurfaceVariant,
          stateLabel: label(state),
        ),
    };
  }
}
