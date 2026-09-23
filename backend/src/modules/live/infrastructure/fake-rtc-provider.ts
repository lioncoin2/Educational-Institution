import {
  RtcUnavailableError,
  type RtcAccessGrant,
  type RtcAccessToken,
  type RtcApplyOutcome,
  type RtcCapabilities,
  type RtcParticipantObservation,
  type RtcProvider,
  type RtcRoomObservation,
  type RtcRoomSpec,
  type RtcSource,
} from '../domain/rtc-provider';

/**
 * An RtcProvider that records instead of calling out.
 *
 * Its existence is the proof that the port is a real abstraction: the whole
 * live feature — join, raise, lower, grant, decline, revoke — runs end to end
 * against it with no media server anywhere. Development without LiveKit
 * credentials uses it too, and says so in the startup log; it never produces
 * a usable media grant.
 *
 * Tests script it: who is absent from a room (`not_connected`), whether the
 * provider is reachable at all (`unavailable`), and what an observer sees.
 */
export class FakeRtcProvider implements RtcProvider {
  readonly rooms: RtcRoomSpec[] = [];
  readonly issued: RtcAccessGrant[] = [];
  readonly capabilityChanges: Array<{
    roomName: string;
    identity: string;
    capabilities: RtcCapabilities;
  }> = [];
  readonly muted: Array<{ roomName: string; identity: string; sources: readonly RtcSource[] }> = [];
  readonly removed: Array<{ roomName: string; identity: string }> = [];
  readonly ended: string[] = [];

  /** When true, every call that would reach the provider fails as it would on an outage. */
  unavailable = false;
  /** `${room}\u0000${identity}` pairs that are not in their room right now. */
  private readonly absent = new Set<string>();
  /** What `listParticipants` returns per room. */
  private readonly observed = new Map<string, RtcParticipantObservation[]>();

  markAbsent(roomName: string, identity: string): void {
    this.absent.add(`${roomName}\u0000${identity}`);
  }

  markPresent(roomName: string, identity: string): void {
    this.absent.delete(`${roomName}\u0000${identity}`);
  }

  observe(roomName: string, participants: readonly RtcParticipantObservation[]): void {
    this.observed.set(roomName, [...participants]);
  }

  async ensureRoom(spec: RtcRoomSpec): Promise<void> {
    this.reachable('ensureRoom');
    this.rooms.push(spec);
  }

  async endRoom(roomName: string): Promise<void> {
    this.reachable('endRoom');
    this.ended.push(roomName);
  }

  async listRooms(roomNames?: readonly string[]): Promise<readonly RtcRoomObservation[]> {
    this.reachable('listRooms');
    return this.rooms
      .filter((room) => roomNames === undefined || roomNames.includes(room.roomName))
      .map((room) => ({
        roomName: room.roomName,
        participantCount: this.observed.get(room.roomName)?.length ?? 0,
        createdAt: new Date(0),
      }));
  }

  async issueAccessToken(grant: RtcAccessGrant): Promise<RtcAccessToken> {
    // Signing is local — an unreachable provider does not stop it.
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
  ): Promise<RtcApplyOutcome> {
    this.reachable('updateCapabilities');
    if (this.isAbsent(roomName, identity)) return 'not_connected';
    this.capabilityChanges.push({ roomName, identity, capabilities });
    return 'applied';
  }

  async removeParticipant(roomName: string, identity: string): Promise<RtcApplyOutcome> {
    this.reachable('removeParticipant');
    if (this.isAbsent(roomName, identity)) return 'not_connected';
    this.removed.push({ roomName, identity });
    return 'applied';
  }

  async muteParticipant(
    roomName: string,
    identity: string,
    sources: readonly RtcSource[],
  ): Promise<RtcApplyOutcome> {
    this.reachable('muteParticipant');
    if (this.isAbsent(roomName, identity)) return 'not_connected';
    this.muted.push({ roomName, identity, sources });
    return 'applied';
  }

  async listParticipants(roomName: string): Promise<readonly RtcParticipantObservation[]> {
    this.reachable('listParticipants');
    return this.observed.get(roomName) ?? [];
  }

  async getParticipant(
    roomName: string,
    identity: string,
  ): Promise<RtcParticipantObservation | null> {
    this.reachable('getParticipant');
    return (this.observed.get(roomName) ?? []).find((p) => p.identity === identity) ?? null;
  }

  private isAbsent(roomName: string, identity: string): boolean {
    return this.absent.has(`${roomName}\u0000${identity}`);
  }

  private reachable(operation: string): void {
    if (this.unavailable) throw new RtcUnavailableError(operation);
  }
}
