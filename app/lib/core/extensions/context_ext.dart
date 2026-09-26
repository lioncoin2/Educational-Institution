import 'package:flutter/material.dart';

import '../theme/app_tokens.dart';

extension AppContextX on BuildContext {
  ColorScheme get colors => Theme.of(this).colorScheme;
  TextTheme get text => Theme.of(this).textTheme;
  bool get isDark => Theme.of(this).brightness == Brightness.dark;

  Breakpoint get breakpoint => Breakpoint.of(MediaQuery.sizeOf(this).width);
  double get gutter => breakpoint.gutter;

  void toast(String message) => ScaffoldMessenger.of(this).toast(message);
}

extension AppMessengerX on ScaffoldMessengerState {
  /// The app's one short message: it replaces any shown, for 3 s. Taken
  /// from a messenger held before an await, it still shows when the widget
  /// that asked is gone by the time the answer comes.
  void toast(String message) {
    this
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(content: Text(message), duration: const Duration(seconds: 3)),
      );
  }
}
