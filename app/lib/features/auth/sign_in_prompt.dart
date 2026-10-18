import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../data/models/academic.dart';
import '../../data/models/admin.dart';
import '../../data/models/attendance.dart';
import '../../data/models/auth.dart';
import '../../data/models/notifications.dart';
import '../../data/models/people.dart';

/// "Sign in to see this" — for the screens whose data is someone's own record
/// on the server, when nobody is signed in on this device.
class SignInPrompt extends StatelessWidget {
  const SignInPrompt({
    super.key,
    this.title = 'سجّلي الدخول للمتابعة',
    this.onReturn,
  });

  final String title;

  /// Called when the sign-in screen this prompt opened closes again —
  /// signed in or not: the screen underneath asks the session itself.
  final VoidCallback? onReturn;

  @override
  Widget build(BuildContext context) {
    return EmptyState(
      icon: Icons.lock_outline_rounded,
      title: title,
      actionLabel: 'تسجيل الدخول',
      onAction: () async {
        await context.push(Routes.signIn);
        if (context.mounted) onReturn?.call();
      },
    );
  }

  /// The prompt, when [error] is a refusal only a sign-in can answer; null
  /// otherwise (a real failure keeps its retry). A retry cannot answer
  /// "nobody is signed in" — after a session ends on a screen, or a screen is
  /// opened by its address signed out, the way on is to sign in, and then
  /// [onReturn] reads the screen again.
  static Widget? forError(Object error, {VoidCallback? onReturn}) =>
      needsSignIn(error) ? SignInPrompt(onReturn: onReturn) : null;

  /// Whether [error] is the server's "nobody is signed in" — whichever
  /// feature's refusal carries it.
  static bool needsSignIn(Object error) => switch (error) {
    AcademicException(:final needsSignIn) ||
    AdminException(:final needsSignIn) ||
    AttendanceException(:final needsSignIn) ||
    NotificationsException(:final needsSignIn) ||
    PeopleException(:final needsSignIn) => needsSignIn,
    AuthException(:final code) => code == _authenticationRequired,
    _ => false,
  };

  static const _authenticationRequired = 'identity.authentication_required';
}
