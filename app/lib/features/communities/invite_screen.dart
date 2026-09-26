import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../core/extensions/context_ext.dart';
import '../../core/theme/app_tokens.dart';
import '../../core/widgets/foundations/app_card.dart';
import '../../core/widgets/foundations/async_view.dart';
import '../../core/widgets/foundations/empty_state.dart';
import '../../core/widgets/layout/responsive_body.dart';
import '../../providers/app_providers.dart';
import '../auth/sign_in_prompt.dart';
import 'community_copy.dart';
import 'state/community_write.dart';
import 'state/invitation_join_controller.dart';
import 'widgets/community_change.dart';

/// Opening an invitation link (`/invite`). The link itself never reaches
/// this route: main() took its token out of the address bar before the app
/// started, into the one holder the screen's state reads.
///
/// Nothing is joined by opening a link. The screen says only that the
/// viewer has been invited to a community — nothing more is known before
/// joining — and they join with one tap, signed in first: the link waits in
/// memory across the sign-in. Joined, they go to the community. Refused for
/// good, it says so, and offers the way to their communities; anything
/// passing keeps the link for another try. Back here once it is used, there
/// is nothing to open.
class InviteScreen extends ConsumerWidget {
  const InviteScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(invitationJoinProvider);
    return Scaffold(
      appBar: AppBar(title: const Text(CommunityCopy.inviteTitle)),
      body: SafeArea(
        top: false,
        child: SingleChildScrollView(
          child: ResponsiveBody(
            child: switch (state) {
              NoInvitation() => const _Nothing(
                title: CommunityCopy.noInvitation,
              ),
              ClosedInvitation(:final code) => _Nothing(
                title: CommunityCopy.joinFailed(code),
              ),
              JoinedInvitation(:final community) => EmptyState(
                icon: Icons.check_circle_outline_rounded,
                title: CommunityCopy.inTheCommunity,
                actionLabel: CommunityCopy.toCommunity,
                onAction: () => context.go(Routes.community(community.id)),
              ),
              OpenInvitation() => _Open(state: state),
            },
          ),
        ),
      ),
    );
  }
}

/// No invitation to act on — none, or not any more: the way to the
/// viewer's communities.
class _Nothing extends StatelessWidget {
  const _Nothing({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return EmptyState(
      icon: Icons.link_off_rounded,
      title: title,
      actionLabel: CommunityCopy.toCommunities,
      onAction: () => context.go(Routes.communities),
    );
  }
}

/// A link to answer: to someone signed in, the invitation and its button;
/// to anyone else, the way to sign in first.
class _Open extends ConsumerWidget {
  const _Open({required this.state});

  final OpenInvitation state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // The server asked for a sign-in: whatever the session still says.
    if (state.signInNeeded) {
      return SignInPrompt(
        title: CommunityCopy.signInToJoin,
        onReturn: () =>
            ref.read(invitationJoinProvider.notifier).backFromSignIn(),
      );
    }
    return AsyncView(
      value: ref.watch(sessionUserProvider),
      onRetry: () => ref.invalidate(sessionUserProvider),
      builder: (context, user) => user == null
          ? const SignInPrompt(title: CommunityCopy.signInToJoin)
          : _Invitation(state: state),
    );
  }
}

class _Invitation extends ConsumerWidget {
  const _Invitation({required this.state});

  final OpenInvitation state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final failure = state.failure;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Insets.xxl),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 72,
                height: 72,
                decoration: BoxDecoration(
                  color: context.colors.primaryContainer,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  Icons.group_add_outlined,
                  size: 32,
                  color: context.colors.onPrimaryContainer,
                ),
              ),
            ),
            const SizedBox(height: Insets.lg),
            Text(
              CommunityCopy.invited,
              textAlign: TextAlign.center,
              style: context.text.titleMedium,
            ),
            if (failure != null) ...[
              const SizedBox(height: Insets.md),
              Text(
                CommunityCopy.joinFailed(failure.code),
                textAlign: TextAlign.center,
                style: context.text.bodyMedium?.copyWith(
                  color: context.colors.error,
                ),
              ),
            ],
            const SizedBox(height: Insets.xl),
            FilledButton(
              onPressed: state.joining ? null : () => _join(context, ref),
              child: state.joining
                  ? const BusyIndicator()
                  : Text(
                      failure == null
                          ? CommunityCopy.join
                          : CommunityCopy.retry,
                    ),
            ),
            const SizedBox(height: Insets.sm),
            TextButton(
              onPressed: () => context.go(Routes.communities),
              child: const Text(CommunityCopy.toCommunities),
            ),
          ],
        ),
      ),
    );
  }

  /// One tap, one request. Joined: to the community, in place of this
  /// screen — the link is used, and there is no going back to it.
  Future<void> _join(BuildContext context, WidgetRef ref) async {
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    final outcome = await ref.read(invitationJoinProvider.notifier).join();
    if (outcome case WriteDone(value: final community)) {
      messenger.toast(CommunityCopy.inTheCommunity);
      router.go(Routes.community(community.id));
    }
  }
}
