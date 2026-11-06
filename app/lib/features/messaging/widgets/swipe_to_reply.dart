import 'package:flutter/material.dart';

import '../../../core/theme/app_tokens.dart';

/// Telegram's reply gesture: drag a message sideways and release past a short
/// threshold to reply to it. The bubble follows the finger a little, a reply
/// glyph fades in as the threshold nears, and everything springs back on
/// release. Purely an affordance over the existing [onReply] — it owns no reply
/// logic, so it is the same on every message and is tested with a plain
/// callback. When [onReply] is null (the viewer cannot reply here) it is inert
/// and just renders its child.
class SwipeToReply extends StatefulWidget {
  const SwipeToReply({super.key, required this.child, this.onReply});

  final Widget child;
  final VoidCallback? onReply;

  /// How far the bubble must travel before a release fires the reply.
  static const double threshold = 56;

  /// The furthest the bubble follows the finger (past the threshold it resists).
  static const double _maxDrag = 76;

  @override
  State<SwipeToReply> createState() => _SwipeToReplyState();
}

class _SwipeToReplyState extends State<SwipeToReply>
    with SingleTickerProviderStateMixin {
  late final AnimationController _spring = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 180),
  )..addListener(() => setState(() => _drag = _drag * _spring.value));

  double _drag = 0;
  bool _fired = false;

  @override
  void dispose() {
    _spring.dispose();
    super.dispose();
  }

  bool get _enabled => widget.onReply != null;

  void _onUpdate(DragUpdateDetails d) {
    if (!_enabled) return;
    // Follow the drag toward the start edge (the natural reply direction in
    // this RTL chat), resisting past the max so it never slides off.
    final next = (_drag + d.primaryDelta!).clamp(0.0, SwipeToReply._maxDrag);
    if (!_fired && next >= SwipeToReply.threshold) {
      _fired = true;
      widget.onReply!();
    }
    setState(() => _drag = next);
  }

  void _release() {
    if (_drag == 0) return;
    _spring
      ..value = 1
      ..animateTo(0, curve: Curves.easeOut);
    _fired = false;
  }

  @override
  Widget build(BuildContext context) {
    final progress = (_drag / SwipeToReply.threshold).clamp(0.0, 1.0);
    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onHorizontalDragUpdate: _onUpdate,
      onHorizontalDragEnd: (_) => _release(),
      onHorizontalDragCancel: _release,
      child: Stack(
        alignment: AlignmentDirectional.centerStart,
        children: [
          if (_drag > 0)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Insets.sm),
              child: Opacity(
                opacity: progress,
                child: Transform.scale(
                  scale: 0.6 + 0.4 * progress,
                  child: Icon(
                    Icons.reply_rounded,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                ),
              ),
            ),
          Transform.translate(offset: Offset(-_drag, 0), child: widget.child),
        ],
      ),
    );
  }
}
