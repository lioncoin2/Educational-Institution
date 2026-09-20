import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app/app_config.dart';
import '../../app/routes.dart';
import '../../core/theme/app_colors.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/layout/contour_background.dart';
import '../../data/sources/profile_data.dart';

/// Identity moment. Dark plum with contour lines — the language of the
/// profile's cover — then straight into the app. No login: the prototype has
/// no authentication of any kind.
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..forward();

  @override
  void initState() {
    super.initState();
    Future.delayed(const Duration(milliseconds: 2100), _enter);
  }

  void _enter() {
    if (!mounted) return;
    context.go(Routes.home);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final fade = CurvedAnimation(parent: _controller, curve: Curves.easeOut);
    final rise = Tween<Offset>(
      begin: const Offset(0, 0.12),
      end: Offset.zero,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic));

    return Scaffold(
      backgroundColor: AppColors.bgDark,
      body: GestureDetector(
        onTap: _enter,
        behavior: HitTestBehavior.opaque,
        child: DecoratedBox(
          decoration: const BoxDecoration(
            gradient: RadialGradient(
              center: Alignment(0.2, -0.4),
              radius: 1.2,
              colors: [Color(0xFF6E3354), AppColors.bgDark],
            ),
          ),
          child: CustomPaint(
            painter: const ContourPainter(
              color: AppColors.primarySoft,
              lines: 18,
              opacity: 0.16,
              amplitude: 36,
            ),
            child: SafeArea(
              child: Center(
                child: FadeTransition(
                  opacity: fade,
                  child: SlideTransition(
                    position: rise,
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.symmetric(
                        horizontal: Insets.xxxl,
                        vertical: Insets.xxl,
                      ),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const _Emblem(),
                          const SizedBox(height: Insets.xxxl),
                          Text(
                            ProfileData.institution.name,
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontFamily: 'Almarai',
                              fontSize: 26,
                              height: 1.5,
                              fontWeight: FontWeight.w800,
                              color: Colors.white,
                            ),
                          ),
                          const SizedBox(height: Insets.lg),
                          Container(
                            width: 64,
                            height: 3,
                            decoration: BoxDecoration(
                              color: AppColors.accentGold,
                              borderRadius: Radii.pill,
                            ),
                          ),
                          const SizedBox(height: Insets.lg),
                          const Text(
                            'تعليم عن بُعد · مجانية بالكامل',
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontFamily: 'PlexArabic',
                              fontSize: 15,
                              height: 1.6,
                              color: AppColors.primarySoft,
                            ),
                          ),
                          const SizedBox(height: Insets.giant),
                          const _StageChip(),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A geometric mark built from the emblem's palette (gold ring, green book).
/// It is not a reproduction of the logo — the real asset is still needed.
class _Emblem extends StatelessWidget {
  const _Emblem();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 112,
      height: 112,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: Colors.white,
        border: Border.all(color: AppColors.accentGold, width: 3),
        boxShadow: [
          BoxShadow(
            color: AppColors.accentGold.withValues(alpha: 0.28),
            blurRadius: 32,
            spreadRadius: 2,
          ),
        ],
      ),
      child: const Icon(
        Icons.menu_book_rounded,
        size: 52,
        color: AppColors.accentGreen,
      ),
    );
  }
}

class _StageChip extends StatelessWidget {
  const _StageChip();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: Insets.lg,
        vertical: Insets.sm,
      ),
      decoration: BoxDecoration(
        borderRadius: Radii.pill,
        border: Border.all(color: Colors.white24),
      ),
      child: const Text(
        AppConfig.stageLabel,
        style: TextStyle(
          fontFamily: 'PlexArabic',
          fontSize: 12,
          color: Colors.white70,
        ),
      ),
    );
  }
}
