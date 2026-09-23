# 0003 — Abstract the RTC provider behind a port

**Status:** Accepted
**Date:** 2026-09-23

## Context

The platform needs live audio rooms holding ~2500 participants. LiveKit is the
intended implementation.

The constraint was explicit: **LiveKit must not leak into the domain layer.**
The domain works with LiveRoom, LiveSession, Participant, SpeakerRequest,
SpeakerPermission and ModerationAction — the institution's vocabulary, not a
vendor's.

## Decision

The domain declares `RtcProvider`. Exactly one file implements it against
LiveKit.

```ts
export interface RtcProvider {
  ensureRoom(spec: RtcRoomSpec): Promise<void>;
  issueAccessToken(grant: RtcAccessGrant): Promise<RtcAccessToken>;
  updateCapabilities(room: string, identity: string, caps: RtcCapabilities): Promise<void>;
  muteParticipant(room: string, identity: string): Promise<void>;
  removeParticipant(room: string, identity: string): Promise<void>;
  endRoom(room: string): Promise<void>;
}
```

Capabilities are ours, not LiveKit's:

```ts
export const LISTENER: RtcCapabilities = { canPublishAudio: false, canSubscribe: true, canPublishData: true };
export const SPEAKER:  RtcCapabilities = { canPublishAudio: true,  canSubscribe: true, canPublishData: true };
```

Two adapters: `LiveKitRtcProvider` and `FakeRtcProvider`. Selected by one
factory in `live.module.ts`, which falls back to the fake when no real
credentials are configured.

## Consequences

**Good.**
- `livekit-server-sdk` is imported by exactly one file in the repository, and
  that is checked by `domain-is-dependency-free` and
  `application-has-no-vendor-sdks`.
- The entire live feature is unit-testable with no network and no credentials.
  The test asserting that a listener's token cannot publish audio — the property
  the 2500-participant design rests on — runs in milliseconds against the fake.
- Replacing LiveKit means writing one file. So does adding a second provider for
  a different region or a different price point.
- `muteParticipant` and `updateCapabilities` are deliberately separate
  operations, because server-side mute and demotion are different acts: a muted
  speaker may keep their grant. Collapsing them would have been easy and would
  have hidden a distinction the moderation model needs.

**Bad, and accepted.**
- The port is the intersection of what providers offer. Anything LiveKit-specific
  and genuinely valuable — egress, simulcast tuning, adaptive stream — is not
  reachable through it without widening the interface.
- Two adapters means the fake can drift from the real one. It is a deliberate
  simplification (no network, no real tokens), so the fake proves our logic is
  right, never that LiveKit behaves as expected. Integration testing against real
  LiveKit remains necessary and is not done.
- A small amount of translation code exists that would not if we called the SDK
  directly — the ws→http URL conversion, the capability mapping.

## Alternatives considered

**Use the LiveKit SDK directly in use cases.** Less code today. Rejected: the
domain becomes untestable without credentials, LiveKit's data model spreads
through the application layer, and replacing the provider becomes a rewrite of
the feature rather than of an adapter. The brief also forbade it explicitly.

**A generic "media server" abstraction covering video, recording, streaming and
egress.** Rejected as speculative generality. The port covers what is actually
needed for audio rooms with moderated speaking. Widening it later is additive;
narrowing an over-broad interface is not.

**No fake; test against a local LiveKit container.** Rejected for the inner
loop: it makes every unit test need Docker, which is the reliable way to make
people stop running them. The fake covers our logic; a real integration test
covers the provider, and belongs in a separate suite.
