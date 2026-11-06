import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../../core/theme/app_tokens.dart';

/// The floating "jump to newest" button, shown while the timeline is scrolled
/// up away from the bottom (Telegram's down-chevron). It carries the unread
/// count as a badge when there is one. Purely presentational: it reads a
/// [show] listenable and calls [onTap]; the screen owns the scroll controller
/// and the unread math.
class ScrollToBottomButton extends StatelessWidget {
  const ScrollToBottomButton({
    super.key,
    required this.show,
    required this.onTap,
    this.unread = 0,
  });

  /// Whether the button is currently visible (the screen flips this as the
  /// timeline scrolls). It slides/fades rather than popping.
  final ValueListenable<bool> show;
  final VoidCallback onTap;
  final int unread;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: show,
      builder: (context, visible, _) => AnimatedSlide(
        offset: visible ? Offset.zero : const Offset(0, 1.6),
        duration: Motion.card,
        curve: Curves.easeOut,
        child: AnimatedOpacity(
          opacity: visible ? 1 : 0,
          duration: Motion.card,
          child: IgnorePointer(
            ignoring: !visible,
            child: _Button(onTap: onTap, unread: unread),
          ),
        ),
      ),
    );
  }
}

class _Button extends StatelessWidget {
  const _Button({required this.onTap, required this.unread});

  final VoidCallback onTap;
  final int unread;

  @override
  Widget build(BuildContext context) {
    final button = FloatingActionButton.small(
      heroTag: null,
      tooltip: 'إلى آخر الرسائل',
      onPressed: onTap,
      child: const Icon(Icons.keyboard_arrow_down_rounded),
    );
    if (unread <= 0) return button;
    return Badge(
      label: Text(unread > 99 ? '99+' : '$unread'),
      offset: const Offset(-4, 4),
      child: button,
    );
  }
}
