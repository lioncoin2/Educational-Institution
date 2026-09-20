import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/theme/app_theme.dart';
import '../providers/app_providers.dart';
import 'router.dart';

/// Exposed so tests can drive navigation without rebuilding the app shell.
final routerProvider = Provider<GoRouter>((ref) => buildRouter());

class QuranInstitutionApp extends ConsumerWidget {
  const QuranInstitutionApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    final themeMode = ref.watch(themeModeProvider);
    final textScale = ref.watch(textScaleProvider);

    return MaterialApp.router(
      title: 'المؤسسة العالمية لتعليم القرآن الكريم',
      debugShowCheckedModeBanner: false,
      routerConfig: router,
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      themeMode: themeMode,

      // Arabic is the app's only locale, so Flutter resolves Directionality
      // to RTL for the whole tree. No manual mirroring anywhere.
      locale: const Locale('ar'),
      supportedLocales: const [Locale('ar')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],

      builder: (context, child) {
        final media = MediaQuery.of(context);
        return MediaQuery(
          // The profile's audiences include كبار السن and محو الأمية, so the
          // reader-chosen scale is combined with the system one and capped so
          // layouts cannot break.
          data: media.copyWith(
            textScaler: TextScaler.linear(
              (media.textScaler.scale(1) * textScale).clamp(0.85, 1.35),
            ),
          ),
          child: child ?? const SizedBox.shrink(),
        );
      },
    );
  }
}
