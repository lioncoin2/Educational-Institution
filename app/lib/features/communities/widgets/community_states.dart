import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/async_view.dart';
import '../../../core/widgets/foundations/empty_state.dart';
import '../../../data/models/communities.dart';
import '../../auth/sign_in_prompt.dart';
import '../community_copy.dart';

/// A failed read, said in words the person can act on: the server's code
/// through [CommunityCopy.error], and a retry. A refusal only signing in
/// answers becomes the sign-in prompt instead — and once the sign-in closes,
/// the read is tried again.
///
/// [compact]: a line above what else the screen shows — for a read of the
/// community's own `me` that failed on a screen whose list did not.
class CommunityErrorView extends StatelessWidget {
  const CommunityErrorView({
    super.key,
    required this.error,
    required this.onRetry,
    this.compact = false,
  });

  final Object error;
  final VoidCallback onRetry;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final error = this.error;
    if (error is CommunityException && error.needsSignIn) {
      return SignInPrompt(title: CommunityCopy.signInTitle, onReturn: onRetry);
    }
    final said = CommunityCopy.error(
      error is CommunityException ? error.code : null,
    );
    if (compact) {
      return Row(
        children: [
          Icon(
            Icons.cloud_off_rounded,
            size: 18,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(width: Insets.sm),
          Expanded(child: Text(said, style: context.text.bodyMedium)),
          const SizedBox(width: Insets.sm),
          TextButton(
            onPressed: onRetry,
            child: const Text(CommunityCopy.retry),
          ),
        ],
      );
    }
    return Padding(
      padding: const EdgeInsets.all(Insets.xxl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.cloud_off_rounded,
            size: 40,
            color: context.colors.onSurfaceVariant,
          ),
          const SizedBox(height: Insets.md),
          Text(
            said,
            textAlign: TextAlign.center,
            style: context.text.titleMedium,
          ),
          const SizedBox(height: Insets.md),
          OutlinedButton(
            onPressed: onRetry,
            child: const Text(CommunityCopy.retry),
          ),
        ],
      ),
    );
  }
}

/// The community is not the viewer's (any more): say so, and offer the way
/// back to their list.
class CommunityGoneView extends StatelessWidget {
  const CommunityGoneView({super.key, required this.wasShown});

  /// It was shown, then the membership ended — rather than never shown.
  final bool wasShown;

  @override
  Widget build(BuildContext context) {
    return EmptyState(
      icon: Icons.person_off_outlined,
      title: wasShown ? CommunityCopy.removed : CommunityCopy.gone,
      actionLabel: CommunityCopy.backToList,
      onAction: () => context.go(Routes.communities),
    );
  }
}

/// Grey blocks in the shape of the rows about to load.
class CommunitySkeleton extends StatelessWidget {
  const CommunitySkeleton({super.key, this.rows = 4, this.height = 84});

  final int rows;
  final double height;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (var i = 0; i < rows; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: Insets.sm),
            child: SkeletonBox(height: height),
          ),
      ],
    );
  }
}
