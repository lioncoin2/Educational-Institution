# 0050 — The request to speak is offered only to who cannot speak yet; a room reset tells people what it changed

**Status:** Accepted — 2026-10-25 (owner request C15, issues 2 and 4). Refines what `me.canRaiseHand` means
(live.md §5, §15.3) and completes the Flutter side [ADR 0026](0026-live-participant-control-and-media-reset.md)
deferred ("Flutter is deferred"). No command, permission, migration or reset semantics change.

## Issue 2 — a raise offered to someone who already speaks

**Root cause (proven).** `LiveSessionViews.of` set `me.canRaiseHand` from the community permit
`community.live.raise_hand` alone. OWNER and ADMIN hold `live.raise_hand` with every other permission, so an
OWNER or ADMIN host — who publishes the microphone **by right** (moderator + `live.speak`) — was offered
«طلب الكلمة». On the Trial, 17 of 18 sessions were hosted by OWNER accounts. The app already followed the
server's flag exactly; the flag was wrong.

**Decision.** `me.canRaiseHand` is now *the permit **and** not already speaking by right*
(`!standing.publishesByRight`, the same `LiveStanding` answer the join token and pushed permissions use).
Unchanged: a granted speaker sees "yield", not a request; a listener, a revoked speaker and a student whose
only standing is a delegated screen slot are offered the request (presenting is not speaking — Q56); a
moderator promoted mid-session stops being offered it on the next re-read (`live.session.changed`).

**Not changed: the raise command.** `POST …/hand` still accepts a by-right speaker's raise, idempotently, as
before: refusing it would add no security (it grants nothing) and would break Q54's host-hand rules (only
the host decides their own hand; a host whose hand is revoked keeps the microphone hosting gives them),
which existing tests pin. The offer is a hint; the server still decides every command.

## Issue 4 — the reset "malfunctioned" on screen, not on the server

**Evidence (Trial, session `15ca3cb3…`, 2026-10-25 12:31–12:40).** Three moderator resets, each audited
(`live.session.media_reset`) and each executed as designed: a new room `…​.1/.2/.3` created, the old one
deleted, both participants back in the new room within ~1 s (LiveKit log). Around them: the host-presenter
had to stop and re-claim the presenter slot twice before their screen came back; the granted speaker
yielded their floor and asked again after two of the resets; the moderator got «تمت إعادة ضبط الغرفة»
regardless of the answer.

**Root cause.** The reset is intended — Q64/ADR 0026 — as a media-room generation swap that disconnects
everyone and keeps every grant. No microphone or shared screen survives a room swap, and by product rule
nothing re-opens them by itself. The app (1) rendered the swap as a plain disconnection («انقطع الاتصال»);
(2) never said that the floor / presenter slot was kept and the microphone / screen had to be turned back
on — so people undid their own standing; (3) told the moderator "done" even for `reset: false` (a
concurrent reset or the end had already moved the room); (4) let a fast double tap open two confirmations.

**Decision (app only, intended scope unchanged).** The reset keeps its exact semantics: the epoch and the
room change; no participant, hand, floor, presenter grant, chat message, attendance record or session
history is touched (now pinned by a test). The app:

- shows «أُعيد ضبط غرفة البث — جارٍ إعادة اتصالك بالغرفة الجديدة…» while re-joining after a swap, and
  «أُعيد ضبط الغرفة وأُعيد اتصالك.» for 30 s after, with «ما زلت تملك الكلمة — شغّل الميكروفون من جديد.» (the
  host or a granted speaker, while the microphone is off) and «ما زلت من مُقدّمي العرض — أعد مشاركة شاشتك.»
  (a presenter, while not sharing). The signal is the SDK's own `ROOM_DELETED` drop followed by a liveness
  read that finds the session still live (`LiveRoomResetNotifier`) — which every connected device sees even
  if the `live.session.media_reset` frame is lost; a room deleted because the session ended shows nothing;
  leaving clears it;
- tells the moderator what the server answered: «تمت إعادة ضبط الغرفة.» for `reset: true`, «لم تتغيّر
  الغرفة: سبقتها إعادة ضبط أخرى أو انتهت الجلسة.» for `reset: false`, the server's code for a refusal;
- opens one confirmation and sends one request however often the button is tapped.

## Consequences

Tests: `session-views.spec.ts` (an ADMIN moderator is not offered the raise; a listener and a presenting
student are), Flutter `live_speaking_controls_test.dart` (host, listener, non-permitted viewer, granted,
revoked, presenter, a realtime sequence ending in a promotion); `participant-control.spec.ts` (a reset moves
only the epoch — floor, waiting hand, presenter slot and chat stay; nobody removed), Flutter
`live_room_reset_test.dart` (true / false / refusal / double tap / cancel; re-join note; speaker and
presenter hints; ended session; leaving).
Open: restoring the microphone automatically after a reset would change the "joining never opens the
microphone" product rule — not done, not approved.
