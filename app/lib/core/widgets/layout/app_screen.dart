import 'package:flutter/material.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';
import 'responsive_body.dart';

/// Standard inner screen: a back-aware app bar plus a scrolling body that is
/// width-capped on large displays.
///
/// RTL note: nothing here flips anything manually. With `locale: ar` Flutter
/// resolves `Directionality.rtl`, which already mirrors the leading/trailing
/// slots and the back arrow.
class AppScreen extends StatelessWidget {
  const AppScreen({
    super.key,
    required this.title,
    required this.slivers,
    this.actions,
    this.bottom,
    this.floatingActionButton,
    this.subtitle,
  });

  final String title;
  final String? subtitle;
  final List<Widget> slivers;
  final List<Widget>? actions;
  final Widget? bottom;
  final Widget? floatingActionButton;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
            if (subtitle != null)
              Text(
                subtitle!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.text.labelSmall,
              ),
          ],
        ),
        actions: actions,
      ),
      floatingActionButton: floatingActionButton,
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            Expanded(
              child: CustomScrollView(
                slivers: [
                  ...slivers,
                  const SliverToBoxAdapter(
                    child: SizedBox(height: Insets.huge),
                  ),
                ],
              ),
            ),
            if (bottom != null)
              ResponsiveBody(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: Insets.lg),
                  child: bottom,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Sliver helper that applies the responsive gutter to ordinary widgets.
class SliverGutter extends StatelessWidget {
  const SliverGutter({
    super.key,
    required this.child,
    this.top = 0,
    this.bottom = 0,
  });

  final Widget child;
  final double top;
  final double bottom;

  @override
  Widget build(BuildContext context) {
    return SliverToBoxAdapter(
      child: Padding(
        padding: EdgeInsets.only(top: top, bottom: bottom),
        child: ResponsiveBody(child: child),
      ),
    );
  }
}
