import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../data/models/academic.dart';

/// "Sign in to see this" — for the screens whose data is someone's own record
/// on the server, when nobody is signed in on this device.
class SignInPrompt extends StatelessWidget {
  const SignInPrompt({super.key, this.title = 'سجّلي الدخول للمتابعة'});

  final String title;

  @override
  Widget build(BuildContext context) {
    return EmptyState(
      icon: Icons.lock_outline_rounded,
      title: title,
      actionLabel: 'تسجيل الدخول',
      onAction: () => context.push(Routes.signIn),
    );
  }

  /// The prompt, when [error] is a refusal only a sign-in can answer; null
  /// otherwise (a real failure keeps its retry).
  static Widget? forError(Object error) =>
      error is AcademicException && error.needsSignIn
      ? const SignInPrompt()
      : null;
}
