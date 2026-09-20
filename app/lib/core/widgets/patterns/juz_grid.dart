import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

/// The thirty ajzaa of "مدينة الحفاظ" (profile page 10, badge "30 جزء").
///
/// The grid of 30 is real. Which ones are marked done is mock.
class JuzGrid extends StatelessWidget {
  const JuzGrid({super.key, required this.memorised, this.total = 30});

  final List<int> memorised;
  final int total;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth > 420 ? 10 : 6;
        return GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          padding: EdgeInsets.zero,
          itemCount: total,
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: columns,
            mainAxisSpacing: Insets.sm,
            crossAxisSpacing: Insets.sm,
            childAspectRatio: 1,
          ),
          itemBuilder: (context, index) {
            final juz = index + 1;
            final done = memorised.contains(juz);
            return Semantics(
              label: done ? 'الجزء $juz محفوظ' : 'الجزء $juz',
              child: Container(
                decoration: BoxDecoration(
                  color: done
                      ? context.colors.primary
                      : context.colors.surfaceContainerHigh,
                  borderRadius: Radii.brSm,
                ),
                alignment: Alignment.center,
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Padding(
                    padding: const EdgeInsets.all(2),
                    child: Text(
                      '$juz',
                      style: context.text.labelMedium?.copyWith(
                        color: done
                            ? context.colors.onPrimary
                            : context.colors.onSurfaceVariant,
                        fontWeight: done ? FontWeight.w700 : FontWeight.w500,
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }
}
