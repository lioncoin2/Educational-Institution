import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../../../core/widgets/foundations/app_card.dart';
import '../../../core/widgets/foundations/stat_badge.dart';
import '../../../data/models/communities.dart';
import '../community_copy.dart';

/// One roster row: the name the directory has (or a neutral word — never an
/// id or an email in its place), when they joined, and whether the ACCOUNT
/// is inactive — and, at its end, what may be done with this member, if
/// anything.
class MemberTile extends StatelessWidget {
  const MemberTile({super.key, required this.member, this.action});

  final CommunityMember member;

  /// The row's actions button; null when nothing may be done with this
  /// member — never anything on the viewer's own row.
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final name = member.displayName;
    return AppCard(
      padding: const EdgeInsets.all(Insets.md),
      semanticLabel: CommunityCopy.memberLabel(member),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            alignment: AlignmentDirectional.center,
            decoration: BoxDecoration(
              color: context.colors.secondaryContainer,
              shape: BoxShape.circle,
            ),
            child: name == null
                ? Icon(
                    Icons.person_outline_rounded,
                    size: 20,
                    color: context.colors.onSecondaryContainer,
                  )
                : Text(
                    String.fromCharCode(name.runes.first),
                    style: context.text.titleMedium?.copyWith(
                      color: context.colors.onSecondaryContainer,
                    ),
                  ),
          ),
          const SizedBox(width: Insets.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name ?? CommunityCopy.unnamedMember,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.titleSmall,
                ),
                const SizedBox(height: Insets.xs),
                Wrap(
                  spacing: Insets.sm,
                  runSpacing: Insets.xs,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      CommunityCopy.joined(context, member.joinedAt),
                      style: context.text.bodySmall,
                    ),
                    if (!member.active)
                      const StatBadge(
                        label: CommunityCopy.inactiveAccount,
                        icon: Icons.person_off_outlined,
                        tone: StatBadgeTone.soft,
                      ),
                  ],
                ),
              ],
            ),
          ),
          if (action case final action?) ...[
            const SizedBox(width: Insets.sm),
            action,
          ],
        ],
      ),
    );
  }
}
