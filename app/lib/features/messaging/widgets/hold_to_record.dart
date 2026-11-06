import 'package:flutter/material.dart';

/// A press-and-hold gesture wrapper for recording a voice message, Telegram
/// style: hold [child] to record, release to finish, slide sideways past a
/// threshold while holding to arm a cancel and release to discard.
///
/// It owns the GESTURE only; the composer owns the recorder seam and the UI.
/// The wrapped child must stay MOUNTED for the whole press (the gesture dies if
/// its detector is rebuilt away mid-hold), so the composer keeps this control in
/// place and swaps only the rest of the row while recording.
class HoldToRecord extends StatefulWidget {
  const HoldToRecord({
    super.key,
    required this.enabled,
    required this.child,
    required this.onStart,
    required this.onCancelArmedChanged,
    required this.onEnd,
    this.onQuickTap,
    this.cancelThreshold = 90,
  });

  /// When false the hold does nothing (no recorder here, or not allowed).
  final bool enabled;
  final Widget child;

  /// The hold began — start recording.
  final VoidCallback onStart;

  /// The finger crossed into / out of the cancel zone — for a live hint.
  final ValueChanged<bool> onCancelArmedChanged;

  /// The hold ended: [cancelled] true = discard (released armed, or the gesture
  /// was interrupted), false = finish and send.
  final void Function({required bool cancelled}) onEnd;

  /// A quick tap (not a hold) — e.g. to hint "اضغط مطوّلًا للتسجيل".
  final VoidCallback? onQuickTap;

  /// Horizontal distance (logical px) from the press origin that arms a cancel.
  final double cancelThreshold;

  @override
  State<HoldToRecord> createState() => _HoldToRecordState();
}

class _HoldToRecordState extends State<HoldToRecord> {
  bool _active = false;
  bool _armed = false;

  void _setArmed(bool armed) {
    if (armed == _armed) return;
    _armed = armed;
    widget.onCancelArmedChanged(armed);
  }

  void _end({required bool cancelled}) {
    if (!_active) return;
    _active = false;
    _armed = false;
    widget.onEnd(cancelled: cancelled);
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.enabled) return widget.child;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onQuickTap,
      onLongPressStart: (_) {
        _active = true;
        _armed = false;
        widget.onStart();
      },
      onLongPressMoveUpdate: (details) {
        if (!_active) return;
        // Either horizontal direction cancels — forgiving, and RTL-agnostic.
        _setArmed(details.offsetFromOrigin.dx.abs() > widget.cancelThreshold);
      },
      onLongPressEnd: (_) => _end(cancelled: _armed),
      // The system stole the gesture (a scroll, a route change): discard, never
      // silently send a recording the viewer did not choose to.
      onLongPressCancel: () => _end(cancelled: true),
      child: widget.child,
    );
  }
}
