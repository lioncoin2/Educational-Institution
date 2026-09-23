# Realtime Audio — the 2500-participant design

The requirement: **~2500 concurrent participants in one audio room.** One
teacher speaks. Students listen and cannot publish by default. "Raise Hand"
enters a queue. The teacher grants and revokes speaking permission.

The instruction that shaped this document:

> Do NOT assume that 2500 participants automatically works just because the UI
> displays 2500.

So this document is organized around what actually breaks at that scale, what
the design does about it, and — at the end, explicitly — **what has been proven
and what has not.**

---

## 1. Why 2500 is a different problem from 25

A naive conference room is a mesh or a selective-forwarding unit where every
participant both publishes and subscribes. Cost grows roughly with the square of
the participant count. At 2500 this is not "slow"; it is impossible.

The saving property of this use case is its **asymmetry**: at any moment there
is one speaker, occasionally a handful. 2499 people are receive-only.

So the architecture's job is to make that asymmetry a hard, server-enforced
guarantee rather than a hopeful UI convention.

### Three failure modes, named

1. **Publish storm.** If listeners *can* publish, a client bug, a malicious
   user, or an over-eager "unmute" button turns 2500 listeners into 2500
   publishers. The SFU dies.
2. **Signalling storm.** 2500 participants joining at the start of a class,
   each triggering presence updates fanned out to everyone else, is O(n²)
   signalling traffic — often the first thing to fall over, before media does.
3. **Coordination state in the media path.** If "who raised their hand" lives in
   the SFU, every hand-raise becomes a media-plane event multiplied by 2500.

---

## 2. The design

### 2.1 Listeners receive tokens that cannot publish

This is the core of it. Capabilities are decided **server-side, at token
issue**, and are carried in the token itself:

```ts
export const LISTENER: RtcCapabilities = {
  canPublishAudio: false,   // ← the property the whole design rests on
  canSubscribe: true,
  canPublishData: true,
};

export const SPEAKER: RtcCapabilities = {
  canPublishAudio: true,
  canSubscribe: true,
  canPublishData: true,
};
```

A client never *asks* for permissions — it receives them. Even a fully
compromised client holding a listener token cannot publish audio, because the
SFU enforces the grant encoded in the token it was given. Failure mode 1 is
closed at the protocol level, not the UI level.

In the LiveKit adapter, even a speaker is restricted to a microphone:

```ts
canPublishSources: grant.capabilities.canPublishAudio ? [TrackSource.MICROPHONE] : []
```

No camera, no screen share, by construction.

This is asserted by a test that exists specifically to protect it:

> `join-live-session.spec.ts` → *"issues a listener token that cannot publish
> audio"* — and the comment above it reads *"The property the whole
> 2500-participant design rests on."*

Four further tests cover the rest of the token decision: the host gets a
publishing token; a participant holding a live grant gets publishing rights back
on reconnect (otherwise every network blip would silently demote a speaker); a
**revoked** grant does not; and nothing is minted at all for a session that is
not live, or for a caller without permission.

### 2.2 The raise-hand queue never touches the media server

`RequestSpeakerUseCase` deliberately does not call `RtcProvider` at all. A
raised hand is application state. It changes nothing on the wire until a host
decides it should.

This is what keeps failure mode 3 closed: 2500 people raising their hands is
2500 rows, not 2500 media-plane events fanned out to 2500 subscribers.

Promotion is the only thing that reaches the provider, and only for the one
participant being promoted.

**Who may promote is asked of identity, with the room in context.** Holding
`live.moderate` means "may moderate rooms you host", not "any room". The use
case asks identity twice: coarsely before loading anything, then with the
room's host in context. The Foundation version checked the permission without
the room, so any teacher could moderate any room. That was fixed in Identity &
Access V1 and is tested against the real authorization service.
Whether anyone other than the host may moderate is open (Q1).

The flow:

```
grant:  own state → provider.updateCapabilities(SPEAKER) → audit → event
revoke: own state → provider.updateCapabilities(LISTENER) → audit → event
```

Own state first, deliberately: if the provider call fails, the system's record
and the media plane disagree, and we would rather be *more* restrictive on
record than have a silent grant. Reconciliation of that divergence is
[open question Q5](open-questions.md).

### 2.3 Concurrent speakers are capped

`MAX_CONCURRENT_SPEAKERS = 4`. The cap is an engineering safeguard, not an
institutional rule — four simultaneous publishers is comfortably within what an
SFU handles while keeping the room intelligible. The *right* number for this
institution is [open question Q4](open-questions.md); the constant is one line.

### 2.4 The queue is a state machine, not a set of booleans

```
pending  → granted | declined | withdrawn
granted  → revoked
revoked | declined | withdrawn  → (terminal)
```

Encoded as an explicit `ALLOWED_TRANSITIONS` table with `canTransition()` and
`transition()`, and unit-tested. `withdrawn` (the student lowers their own hand)
is kept distinct from `declined` (the host passes them over), because the
difference matters for reporting — *how often were hands ignored?* is a question
an institution will eventually ask, and it cannot be reconstructed later from a
merged state.

A user may hold only one open hand per session (`hasOpenRequest`).

Ordering is first-come-first-served (`pendingQueue`, oldest first) and is
intentionally not configurable. Any other ordering — by participation, by level,
by whoever spoke least — is an institutional policy we have not been given.

### 2.5 The secret never leaves the server

The LiveKit API key and secret are read only by `platform/config`, and used only
by `LiveKitRtcProvider`. The Flutter client receives a join token with a
**600-second TTL** and the connection URL, which also comes from server
configuration rather than from the client.

A leaked join token is worth one room, one identity, ten minutes, and — for a
listener — no ability to publish anything.

---

## 3. What talks to what

```
Flutter client
     │  POST /live/sessions/:id/join        (institution auth)
     ▼
LiveController ──► JoinLiveSessionUseCase
                        │  1. authorize via identity contracts
                        │  2. session must be live
                        │  3. host? existing grant? → SPEAKER, else LISTENER
                        ▼
                   RtcProvider (port)
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
  LiveKitRtcProvider            FakeRtcProvider
  (the only file that           (tests, and local dev
   imports livekit-server-sdk)   without credentials)
          │
          ▼
     LiveKit SFU ◄──── media ────► Flutter client
```

The client talks to our API for *permission* and to the SFU for *media*. It
never talks to the SFU about permission.

---

## 4. Persistence plan (not yet implemented)

Current repositories are in-memory. They implement the ports the real ones will:

| Data | Where it will live | Why |
| --- | --- | --- |
| `LiveRoom`, `LiveSession` | Postgres | Permanent business truth; attendance and reporting derive from it |
| `SpeakerRequest` queue | Redis, projected to Postgres on decision | Ephemeral, high-churn, read constantly during a session |
| Presence / participant counts | Redis, TTL'd | Ephemeral by definition |
| `ModerationAction` | Postgres + audit log | Must survive; someone will ask who muted whom |

Redis holds the live queue; Postgres holds what happened. No permanent business
truth lives only in Redis.

---

## 5. What is proven and what is not

**Proven** (implemented and covered by tests that run in CI):

- A listener's token cannot publish audio.
- A host's token can.
- A live grant survives reconnect; a revoked one does not.
- No token is minted for a non-live session, or for an unauthorized caller.
- The speaker-request state machine rejects every transition outside the table.
- The concurrent-speaker cap is enforced before a grant is issued.
- Moderation is scoped to the room: a teacher cannot moderate a room they do
  not host.
- Moderation writes the institution's audit trail (`live.speaker.granted` /
  `revoked`) and raises a domain event.
- A host publishes only while also holding `live.speak`.
- Nothing outside `livekit-rtc-provider.ts` imports LiveKit.

**Not proven — no load test has been run:**

- That the chosen LiveKit deployment holds 2500 subscribers in one room.
- Join-storm behaviour when a class of 2500 connects within a few seconds.
- Signalling fan-out cost at that participant count (failure mode 2 above is
  *understood*, and is addressed by keeping the queue off the media plane, but
  it has not been *measured*).
- Client-side performance on a low-end Android device subscribed to a room with
  2500 participants in its roster.

**This is the honest state:** the architecture is arranged so that these can be
measured before production, and so that a bad result changes an adapter rather
than the system. Nothing here should be read as a claim that 2500 works today.

### The load test this design is built to permit

1. Point `FakeRtcProvider` at a synthetic client harness; confirm the
   application layer issues 2500 correct listener grants without degradation.
   This isolates *our* code from the SFU's.
2. Run real LiveKit with 2500 headless subscriber clients, one publisher.
   Measure SFU CPU, bandwidth, and join latency at the 50th/95th/99th
   percentile.
3. Join storm: all 2500 within 10 seconds. Measure signalling, not just media.
4. Promotion under load: grant and revoke while 2500 are subscribed. Measure how
   long a promotion takes to take effect.
5. Repeat with participant-list updates disabled on the client, to isolate
   roster fan-out cost.

Step 1 is possible today. Steps 2–5 need an environment and credentials.

---

## 6. Deliberately deferred

- The 2500-user room **UI** — explicitly out of scope for this milestone.
- Recording, transcription, breakout rooms.
- Region/edge selection and SFU autoscaling policy.
- Reconciliation between our permission record and the provider's (Q5).
- Automatic room lifecycle from the schedule — `live` raises the events;
  `automation` will consume them.
