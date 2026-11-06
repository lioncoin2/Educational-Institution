# 0057 — Hold-to-record voice messages

**Status:** Accepted
**Date:** 2026-11-06

## Context

The composer recorded a voice message by TAP-TO-TOGGLE: tap the mic to start,
which swapped the whole input row for a recording row (cancel / waveform /
send), tap send to finish. The owner asked for the Telegram gesture — press and
hold to record, release to send, slide to cancel. This was deferred in the
chat-features plan with a precise reason: the old row SWAPPED the mic button out
the instant recording began, and a long-press gesture dies the moment its
detector is rebuilt away, so the hold could never span start→release.

## Decision

A `HoldToRecord` gesture wrapper (`widgets/hold_to_record.dart`) drives the
existing recorder seam; the composer keeps the hold target MOUNTED across the
whole press and swaps only the rest of the row.

- **One row in both states:** the trailing control (the mic target, or the send
  button when there is text) is always present; only the leading attach button
  and the middle (text field ↔ recording strip) change while recording. The mic
  target is therefore the same element from press to release — the gesture
  survives the start of recording.
- **Gesture:** `onLongPressStart` → start; `onLongPressMoveUpdate` → arm a
  cancel once the finger slides past a horizontal threshold (either direction —
  RTL-agnostic); `onLongPressEnd` → discard if armed, else stop and send;
  `onLongPressCancel` (the system stole the gesture) → discard, never silently
  send. A quick TAP (not a hold) only hints "اضغط مطوّلًا للتسجيل" — it never
  starts a zero-length recording.
- **Recorder seam unchanged:** the composer calls the existing
  `VoiceRecorder.start/stop/cancel`; start is optimistic (the UI flips at once)
  and reverts with a toast on failure. The waveform (`VoiceWave` over the
  recorder's amplitudes) and the recording strip show live, with the cancel hint
  turning red ("أفلت للإلغاء") when armed.
- **The mic tooltip is manual-trigger:** a default `Tooltip` adds its OWN
  long-press recognizer, which would steal the hold; `TooltipTriggerMode.manual`
  keeps the label without a competing gesture.

## Alternatives rejected

- **Keep tap-to-toggle:** the owner asked for the hold gesture; a quick tap now
  hints how to use it, so discoverability is preserved without a second mode.
- **A hands-free "lock" (slide up to keep recording after release):** Telegram
  has it, but it is extra surface; deferred. The slide gesture here is
  cancel-only for now.
- **Directional slide-to-cancel (only toward the field):** rejected for an
  absolute-distance threshold — simpler, works identically in RTL and LTR, and
  forgiving of a slightly angled slide.

## Consequences

- One new widget and a composer restructure; no backend change, no new route,
  permission or model. The recorder seam, the waveform and the send path are
  reused unchanged. A build with no recorder shows the mic disabled with an
  explaining tooltip, exactly as before. Verified: `flutter analyze` clean and
  the Flutter suite, including a gesture-level test (hold→start→release,
  slide→arm→discard, quick-tap→hint) and a composer test (hold the mic → records
  → release → sends a voice file).
