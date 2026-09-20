import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';

/// Caps content width on wide screens and applies the breakpoint gutter, so
/// the mobile-first layouts stay readable when reviewed in a desktop browser.
///
/// The `heightFactor: 1` matters. Scaffold lays out `bottomNavigationBar` with
/// a *loose* (not unbounded) height, so a plain `Center` would expand to the
/// full screen, take the whole Scaffold and leave the body zero pixels tall.
/// Hugging the child's height keeps this safe in every slot.
class ResponsiveBody extends StatelessWidget {
  const ResponsiveBody({
    super.key,
    required this.child,
    this.horizontalPadding = true,
  });

  final Widget child;
  final bool horizontalPadding;

  @override
  Widget build(BuildContext context) {
    final bp = context.breakpoint;
    return Align(
      alignment: Alignment.topCenter,
      heightFactor: 1,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: bp.maxContentWidth),
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: horizontalPadding ? bp.gutter : 0,
          ),
          child: child,
        ),
      ),
    );
  }
}
