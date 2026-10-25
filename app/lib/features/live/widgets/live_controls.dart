import 'package:flutter/material.dart';

import '../../../core/extensions/context_ext.dart';
import '../../../core/theme/app_tokens.dart';
import '../live_copy.dart';

/// Shared chrome for the immersive live room, matching the reference design:
/// a bottom control dock of circular icon buttons, a reactions strip, and a
/// bottom tab bar. Unimplemented capabilities are rendered in their reference
/// positions as LOCKED placeholders — a lock glyph, disabled interaction, the
/// «غير متاح الآن» label, and no callback — so the layout is faithful without
/// ever looking functional or fabricating data.

/// One circular control-dock button: a round icon above a short label, the
/// whole thing one tap target. [locked] renders it inert (lock badge, muted,
/// «غير متاح الآن» to a screen reader) with no callback; [active] fills it with
/// the accent; [danger] tints it for a destructive action; [busy] shows a
/// spinner and disables it. Designed to sit inside an [Expanded] so a row of
/// them never overflows a narrow phone.
class LiveDockButton extends StatelessWidget {
  const LiveDockButton({
    super.key,
    required this.icon,
    required this.label,
    this.onTap,
    this.active = false,
    this.danger = false,
    this.busy = false,
    this.locked = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool active;
  final bool danger;
  final bool busy;
  final bool locked;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final Color bg;
    final Color fg;
    if (locked) {
      bg = colors.surfaceContainer;
      fg = colors.onSurfaceVariant;
    } else if (danger) {
      bg = colors.error;
      fg = colors.onError;
    } else if (active) {
      bg = colors.primary;
      fg = colors.onPrimary;
    } else {
      bg = colors.surfaceContainerHigh;
      fg = colors.onSurface;
    }
    final enabled = !locked && !busy && onTap != null;

    Widget circle = Container(
      width: 52,
      height: 52,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: bg,
        border: (active || danger)
            ? null
            : Border.all(color: colors.outlineVariant),
      ),
      alignment: Alignment.center,
      child: busy
          ? const ExcludeSemantics(
              child: SizedBox.square(
                dimension: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            )
          : Icon(icon, color: fg, size: 24),
    );
    if (locked) {
      circle = Stack(
        clipBehavior: Clip.none,
        children: [
          circle,
          Positioned(
            bottom: -2,
            right: -2,
            child: Container(
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: colors.surfaceContainerHighest,
                shape: BoxShape.circle,
                border: Border.all(color: colors.outlineVariant),
              ),
              child: Icon(
                Icons.lock_outline,
                size: 11,
                color: colors.onSurfaceVariant,
              ),
            ),
          ),
        ],
      );
    }

    return Semantics(
      button: true,
      enabled: enabled,
      label: locked ? '$label — ${LiveCopy.soonBadge}' : label,
      child: Opacity(
        opacity: locked ? 0.7 : 1,
        child: InkWell(
          // A locked control never performs its action; tapping it says, in
          // visible text, that it is intentionally unavailable.
          onTap: locked
              ? () => context.toast(LiveCopy.lockedTapped(label))
              : (enabled ? onTap : null),
          borderRadius: Radii.brMd,
          child: Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: Insets.xs,
              vertical: Insets.sm,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                circle,
                const SizedBox(height: Insets.xs),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                  style: context.text.labelSmall?.copyWith(
                    color: danger && !locked
                        ? colors.error
                        : colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The surface the control dock / tab bar sits on: a dark bar with a hairline,
/// honoring the bottom safe area.
class LiveDockBar extends StatelessWidget {
  const LiveDockBar({super.key, required this.child, this.border = true});

  final Widget child;
  final bool border;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: context.colors.surfaceContainerLow,
        border: border
            ? Border(top: BorderSide(color: context.colors.outlineVariant))
            : null,
      ),
      child: SafeArea(
        top: false,
        minimum: const EdgeInsets.symmetric(
          horizontal: Insets.sm,
          vertical: Insets.sm,
        ),
        child: child,
      ),
    );
  }
}

/// The reactions strip (reference: ❤️ 👍 👏 😊). Reactions are NOT backed, so
/// every pill is a locked placeholder — no count is shown (none exists), the
/// row carries a «غير متاح الآن» caption for a screen reader, and nothing is
/// tappable.
class LiveReactionBar extends StatelessWidget {
  const LiveReactionBar({super.key});

  static const _reactions = <IconData>[
    Icons.favorite_rounded,
    Icons.thumb_up_rounded,
    Icons.sign_language_rounded,
    Icons.emoji_emotions_rounded,
  ];

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Semantics(
      enabled: false,
      label: '${LiveCopy.soonReactions} — ${LiveCopy.soonBadge}',
      child: Opacity(
        opacity: 0.7,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            for (final icon in _reactions) ...[
              Container(
                padding: const EdgeInsets.all(Insets.sm),
                decoration: BoxDecoration(
                  color: colors.surfaceContainerHigh,
                  shape: BoxShape.circle,
                  border: Border.all(color: colors.outlineVariant),
                ),
                child: Icon(icon, size: 18, color: colors.onSurfaceVariant),
              ),
              const SizedBox(width: Insets.sm),
            ],
            Icon(Icons.lock_outline, size: 14, color: colors.onSurfaceVariant),
          ],
        ),
      ),
    );
  }
}

/// A bottom tab in the live room. [LiveTab.participants] is real (it opens the
/// roster); the rest (chat, polls, settings) are locked placeholders in their
/// reference positions.
enum LiveTab { participants, chat, polls, settings }

class LiveBottomTabs extends StatelessWidget {
  const LiveBottomTabs({
    super.key,
    required this.onParticipants,
    required this.onChat,
  });

  final VoidCallback onParticipants;

  /// Opens the community's group conversation (the chat tab is real, via the
  /// access-checked `CommunityChatOpener`).
  final VoidCallback onChat;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: _Tab(
            key: const Key('live-tab-participants'),
            icon: Icons.groups_rounded,
            label: LiveCopy.tabParticipants,
            onTap: onParticipants,
          ),
        ),
        Expanded(
          child: _Tab(
            key: const Key('live-tab-chat'),
            icon: Icons.chat_bubble_outline_rounded,
            label: LiveCopy.tabChat,
            onTap: onChat,
          ),
        ),
        Expanded(
          child: _Tab(
            icon: Icons.bar_chart_rounded,
            label: LiveCopy.tabPolls,
            locked: true,
          ),
        ),
        Expanded(
          child: _Tab(
            icon: Icons.settings_outlined,
            label: LiveCopy.tabSettings,
            locked: true,
          ),
        ),
      ],
    );
  }
}

class _Tab extends StatelessWidget {
  const _Tab({
    super.key,
    required this.icon,
    required this.label,
    this.onTap,
    this.locked = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool locked;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    return Semantics(
      button: true,
      enabled: !locked,
      label: locked ? '$label — ${LiveCopy.soonBadge}' : label,
      child: Opacity(
        opacity: locked ? 0.7 : 1,
        child: InkWell(
          // A locked tab never navigates; tapping it says so in visible text.
          onTap: locked
              ? () => context.toast(LiveCopy.lockedTapped(label))
              : onTap,
          borderRadius: Radii.brMd,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: Insets.sm),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Icon(icon, size: 22, color: colors.onSurfaceVariant),
                    if (locked)
                      const Positioned(
                        right: -6,
                        top: -4,
                        child: Icon(Icons.lock_outline, size: 11),
                      ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: context.text.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
