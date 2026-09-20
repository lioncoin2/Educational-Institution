import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../extensions/context_ext.dart';
import '../../theme/app_tokens.dart';

class NavItem {
  const NavItem({
    required this.label,
    required this.icon,
    required this.selectedIcon,
  });

  final String label;
  final IconData icon;
  final IconData selectedIcon;
}

/// Bottom bar on phones, navigation rail on tablets and desktop.
///
/// In RTL the rail resolves to the right-hand edge on its own — that is why
/// this uses `Row` with the rail first rather than any manual mirroring.
class AdaptiveNavShell extends StatelessWidget {
  const AdaptiveNavShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  static const List<NavItem> items = [
    NavItem(
      label: 'الرئيسية',
      icon: Icons.home_outlined,
      selectedIcon: Icons.home_rounded,
    ),
    NavItem(
      label: 'البرامج',
      icon: Icons.grid_view_outlined,
      selectedIcon: Icons.grid_view_rounded,
    ),
    NavItem(
      label: 'مساري',
      icon: Icons.stairs_outlined,
      selectedIcon: Icons.stairs_rounded,
    ),
    NavItem(
      label: 'الشهادات',
      icon: Icons.workspace_premium_outlined,
      selectedIcon: Icons.workspace_premium_rounded,
    ),
    NavItem(
      label: 'حسابي',
      icon: Icons.person_outline_rounded,
      selectedIcon: Icons.person_rounded,
    ),
  ];

  void _onTap(int index) => shell.goBranch(
        index,
        initialLocation: index == shell.currentIndex,
      );

  @override
  Widget build(BuildContext context) {
    final useRail = !context.breakpoint.isMobile;

    if (!useRail) {
      return Scaffold(
        body: shell,
        bottomNavigationBar: NavigationBar(
          selectedIndex: shell.currentIndex,
          onDestinationSelected: _onTap,
          destinations: [
            for (final item in items)
              NavigationDestination(
                icon: Icon(item.icon),
                selectedIcon: Icon(item.selectedIcon),
                label: item.label,
              ),
          ],
        ),
      );
    }

    final extended = context.breakpoint.isDesktop;
    return Scaffold(
      body: Row(
        children: [
          NavigationRail(
            extended: extended,
            minWidth: 92,
            minExtendedWidth: 208,
            selectedIndex: shell.currentIndex,
            onDestinationSelected: _onTap,
            labelType: extended ? null : NavigationRailLabelType.all,
            leading: Padding(
              padding: const EdgeInsets.symmetric(vertical: Insets.xl),
              child: _RailBrand(extended: extended),
            ),
            destinations: [
              for (final item in items)
                NavigationRailDestination(
                  icon: Icon(item.icon),
                  selectedIcon: Icon(item.selectedIcon),
                  label: Text(item.label),
                ),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(child: shell),
        ],
      ),
    );
  }
}

class _RailBrand extends StatelessWidget {
  const _RailBrand({required this.extended});

  final bool extended;

  @override
  Widget build(BuildContext context) {
    final mark = Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        color: context.colors.primary,
        borderRadius: Radii.brMd,
      ),
      child: Icon(
        Icons.menu_book_rounded,
        size: 22,
        color: context.colors.onPrimary,
      ),
    );

    if (!extended) return mark;

    // Stacked rather than side by side: the rail's leading slot is measured
    // with loose constraints, so a Row with Expanded here overflows.
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: Insets.md),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          mark,
          const SizedBox(height: Insets.sm),
          SizedBox(
            width: 140,
            child: Text(
              'المؤسسة العالمية',
              maxLines: 2,
              textAlign: TextAlign.center,
              overflow: TextOverflow.ellipsis,
              style: context.text.labelMedium,
            ),
          ),
        ],
      ),
    );
  }
}
