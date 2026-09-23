import type {
  RtcAccessGrant,
  RtcAccessToken,
  RtcCapabilities,
  RtcProvider,
  RtcRoomSpec,
} from '../domain/rtc-provider';

/**
 * An RtcProvider that records instead of calling out.
 *
 * Its existence is the proof that the port is a real abstraction: the entire
 * live feature — join, raise hand, grant, revoke — runs end to end against this
 * with no LiveKit process anywhere. It is also what local development uses
 * before LiveKit credentials exist.
 */
export class FakeRtcProvider implements RtcProvider {
  readonly rooms: RtcRoomSpec[] = [];
  readonly issued: RtcAccessGrant[] = [];
  readonly capabilityChanges: Array<{
    roomName: string;
    identity: string;
    capabilities: RtcCapabilities;
  }> = [];
  readonly muted: Array<{ roomName: string; identity: string }> = [];
  readonly removed: Array<{ roomName: string; identity: string }> = [];
  readonly ended: string[] = [];

  async ensureRoom(spec: RtcRoomSpec): Promise<void> {
    this.rooms.push(spec);
  }

  async issueAccessToken(grant: RtcAccessGrant): Promise<RtcAccessToken> {
    this.issued.push(grant);
    return {
      // Deterministic and obviously fake — never mistakable for a real token.
      token: `fake.${grant.roomName}.${grant.identity}.${grant.capabilities.canPublishAudio ? 'pub' : 'sub'}`,
      url: 'ws://fake-rtc.local',
      expiresInSeconds: grant.ttlSeconds,
    };
  }

  async updateCapabilities(
    roomName: string,
    identity: string,
    capabilities: RtcCapabilities,
  ): Promise<void> {
    this.capabilityChanges.push({ roomName, identity, capabilities });
  }

  async muteParticipant(roomName: string, identity: string): Promise<void> {
    this.muted.push({ roomName, identity });
  }

  async removeParticipant(roomName: string, identity: string): Promise<void> {
    this.removed.push({ roomName, identity });
  }

  async endRoom(roomName: string): Promise<void> {
    this.ended.push(roomName);
  }
}
