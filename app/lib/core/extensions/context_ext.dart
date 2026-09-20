import 'package:flutter/material.dart';

import '../theme/app_tokens.dart';

extension AppContextX on BuildContext {
  ColorScheme get colors => Theme.of(this).colorScheme;
  TextTheme get text => Theme.of(this).textTheme;
  bool get isDark => Theme.of(this).brightness == Brightness.dark;

  Breakpoint get breakpoint => Breakpoint.of(MediaQuery.sizeOf(this).width);
  double get gutter => breakpoint.gutter;

  void toast(String message) {
    ScaffoldMessenger.of(this)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          duration: const Duration(seconds: 3),
        ),
      );
  }
}
