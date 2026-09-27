import type { Clock } from '../../../shared';
import {
  RtcUnavailableError,
  sourcesOf,
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

/** Every operation of the RTC ports, as the fake logs and scripts them. */
export const RTC_OPERATIONS = [
  'ensureRoom',
  'endRoom',
  'listRooms',
  'issueAccessToken',
  'updateCapabilities',
  'removeParticipant',
  'muteParticipant',
  'listParticipants',
  'getParticipant',
] as const;
export type RtcOperation = (typeof RTC_OPERATIONS)[number];

/**
 * How a scripted call fails: `unavailable` is an outage — the port's
 * `RtcUnavailableError`, as the adapter throws for a network error, a timeout
 * or a 5xx; `fault` is a refusal or rejected credentials, which the adapter
 * throws as a plain error (a 500, never mistaken for an outage).
 */
export type RtcFailure = 'unavailable' | 'fault';

/** One call as the fake received it, reads included. */
export interface FakeRtcCall {
  readonly operation: RtcOperation;
  /** The room the call named, when it names one. */
  readonly roomName?: string;
  /** The rooms `listRooms` asked for; absent when it asked for every room. */
  readonly roomNames?: readonly string[];
  readonly identity?: string;
  readonly at: Date;
}

/** A room as the fake's registry holds it. */
export interface FakeRoom {
  readonly spec: RtcRoomSpec;
  /** When it was first ensured — an update keeps it. */
  readonly createdAt: Date;
}

/**
 * A held operation. Its calls wait here until `release()`; `reached`
 * resolves when the first one arrives, so a test can make something else
 * happen at exactly that point — a lock committing during Start's
 * `ensureRoom`, an end during a join's room check — and then let it go.
 */
export interface RtcGate {
  readonly reached: Promise<void>;
  release(): void;
}

/**
 * Each log keeps only its newest entries, so development running the fake
 * for days holds a bounded amount of memory.
 */
export const FAKE_RTC_LOG_LIMIT = 1_000;

/**
 * What the fake's tokens look like: `fake.<room>.<identity>.<pub|sub>`.
 * Deterministic and obviously fake — never a JWT, never usable against a
 * media server — so a test can scan captured logs for it.
 */
export const FAKE_TOKEN_PATTERN = /fake\.[A-Za-z0-9._-]+\.(?:pub|sub)/;

/**
 * An RtcProvider that records instead of calling out (audit §9).
 *
 * Its existence is the proof that the port is a real abstraction: the whole
 * live feature runs end to end against it with no media server anywhere.
 * Development without real media uses it too, and says so in the startup log;
 * it never produces a usable media grant.
 *
 * It behaves as the adapter promises a provider does, deterministically:
 *
 *   - a room registry: `ensureRoom` creates or updates (idempotent, keeping
 *     the creation time, taken from the injected clock); `endRoom` removes the
 *     room and everyone in it, and ending a room that is not there succeeds;
 *     `listRooms` reports current rooms only;
 *   - participants are what a test scripts (`observe`, `connect`,
 *     `disconnect`); a change to someone not in the room answers
 *     `not_connected`, and `updateCapabilities`, `removeParticipant` and
 *     `muteParticipant` change what is observed afterwards — a source no
 *     longer allowed stops being published at once, as the provider unpublishes
 *     it;
 *   - failures on demand: `failNext` fails the next call of one operation,
 *     `setUnavailable` fails every call, token signing included, until
 *     cleared;
 *   - `hold` stops an operation's calls at a gate until released, for
 *     deterministic interleavings;
 *   - logs of every call (reads included) and of every effect, removal
 *     options among them — each bounded to its newest FAKE_RTC_LOG_LIMIT.
 *
 * A call is logged when it arrives, waits at its operation's gate if one is
 * held, then fails if a failure is scripted, and only then takes effect.
 */
export class FakeRtcProvider implements RtcProvider {
  private readonly callLog: FakeRtcCall[] = [];
  private readonly issuedLog: RtcAccessGrant[] = [];
  private readonly ensuredLog: RtcRoomSpec[] = [];
  private readonly endedLog: string[] = [];
  private readonly capabilityLog: Array<{
    readonly roomName: string;
    readonly identity: string;
    readonly capabilities: RtcCapabilities;
  }> = [];
  private readonly removedLog: Array<{
    readonly roomName: string;
    readonly identity: string;
    readonly revokeTokensIssuedBefore: Date | null;
  }> = [];
  private readonly mutedLog: Array<{
    readonly roomName: string;
    readonly identity: string;
    readonly sources: readonly RtcSource[];
  }> = [];

  private readonly registry = new Map<string, FakeRoom>();
  /** Room → identity → what an observer sees. One entry per identity: the newest connection wins. */
  private readonly present = new Map<string, Map<string, RtcParticipantObservation>>();
  /** One-shot failures, in the order they were scripted. */
  private readonly scripted = new Map<RtcOperation, RtcFailure[]>();
  private readonly gates = new Map<RtcOperation, { readonly arrive: () => Promise<void> }>();
  private unavailable = false;

  constructor(private readonly clock: Clock) {}

  // ── What a test reads ──────────────────────────────────────────────────

  /** Every call, reads included, oldest first. */
  get calls(): readonly FakeRtcCall[] {
    return this.callLog;
  }

  /** The grants of every token issued (never the tokens). */
  get issued(): readonly RtcAccessGrant[] {
    return this.issuedLog;
  }

  /** Every room spec an `ensureRoom` applied. */
  get ensured(): readonly RtcRoomSpec[] {
    return this.ensuredLog;
  }

  /** Every room an `endRoom` ended — including rooms that were already gone. */
  get ended(): readonly string[] {
    return this.endedLog;
  }

  /** Every capability set applied to someone in a room. */
  get capabilityChanges(): ReadonlyArray<{
    readonly roomName: string;
    readonly identity: string;
    readonly capabilities: RtcCapabilities;
  }> {
    return this.capabilityLog;
  }

  /** Everyone removed from a room, with the options the removal carried. */
  get removed(): ReadonlyArray<{
    readonly roomName: string;
    readonly identity: string;
    readonly revokeTokensIssuedBefore: Date | null;
  }> {
    return this.removedLog;
  }

  get muted(): ReadonlyArray<{
    readonly roomName: string;
    readonly identity: string;
    readonly sources: readonly RtcSource[];
  }> {
    return this.mutedLog;
  }

  /** A current room, or null — without logging a call. */
  room(roomName: string): FakeRoom | null {
    return this.registry.get(roomName) ?? null;
  }

  /** The current rooms' names, in creation order — without logging a call. */
  roomNames(): readonly string[] {
    return [...this.registry.keys()];
  }

  /** Who is observed in a room now — without logging a call. */
  observed(roomName: string): readonly RtcParticipantObservation[] {
    return [...(this.present.get(roomName)?.values() ?? [])];
  }

  // ── What a test scripts ────────────────────────────────────────────────

  /** Fails the next call of `operation`; several are used up in order. */
  failNext(operation: RtcOperation, failure: RtcFailure): void {
    const queue = this.scripted.get(operation) ?? [];
    queue.push(failure);
    this.scripted.set(operation, queue);
  }

  /** While set, every call fails as on an outage — token signing included, as the disabled provider does. */
  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  /** Stops `operation`'s calls at a gate until it is released. One gate per operation at a time. */
  hold(operation: RtcOperation): RtcGate {
    if (this.gates.has(operation)) throw new Error(`${operation} is already held`);
    let arrived!: () => void;
    let open!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const gate = {
      arrive: () => {
        arrived();
        return opened;
      },
    };
    this.gates.set(operation, gate);
    return {
      reached,
      release: () => {
        if (this.gates.get(operation) === gate) this.gates.delete(operation);
        open();
      },
    };
  }

  /** Replaces who is observed in a room. */
  observe(roomName: string, participants: readonly RtcParticipantObservation[]): void {
    this.present.set(
      roomName,
      new Map(participants.map((participant) => [participant.identity, participant])),
    );
  }

  /** Someone connects to a room now, holding `capabilities` and publishing `publishing`. */
  connect(
    roomName: string,
    identity: string,
    capabilities: RtcCapabilities,
    publishing: readonly RtcSource[] = [],
  ): void {
    this.inRoom(roomName).set(identity, {
      identity,
      state: 'active',
      standard: true,
      joinedAt: this.clock.now(),
      publishing,
      capabilities,
    });
  }

  /** Someone leaves a room. */
  disconnect(roomName: string, identity: string): void {
    this.present.get(roomName)?.delete(identity);
  }

  // ── Rooms ──────────────────────────────────────────────────────────────

  async ensureRoom(spec: RtcRoomSpec): Promise<void> {
    await this.admit('ensureRoom', { roomName: spec.roomName });
    const existing = this.registry.get(spec.roomName);
    this.registry.set(spec.roomName, { spec, createdAt: existing?.createdAt ?? this.clock.now() });
    keep(this.ensuredLog, spec);
  }

  async endRoom(roomName: string): Promise<void> {
    await this.admit('endRoom', { roomName });
    // A room that does not exist is already ended; everyone in one that does is disconnected.
    this.registry.delete(roomName);
    this.present.delete(roomName);
    keep(this.endedLog, roomName);
  }

  async listRooms(roomNames?: readonly string[]): Promise<readonly RtcRoomObservation[]> {
    await this.admit('listRooms', roomNames === undefined ? {} : { roomNames: [...roomNames] });
    return [...this.registry]
      .filter(([name]) => roomNames === undefined || roomNames.includes(name))
      .map(([name, room]) => ({
        roomName: name,
        participantCount: this.present.get(name)?.size ?? 0,
        createdAt: room.createdAt,
      }));
  }

  // ── Tokens ─────────────────────────────────────────────────────────────

  async issueAccessToken(grant: RtcAccessGrant): Promise<RtcAccessToken> {
    await this.admit('issueAccessToken', { roomName: grant.roomName, identity: grant.identity });
    keep(this.issuedLog, grant);
    const publishes = sourcesOf(grant.capabilities).length > 0;
    return {
      token: `fake.${grant.roomName}.${grant.identity}.${publishes ? 'pub' : 'sub'}`,
      url: 'ws://fake-rtc.local',
      expiresInSeconds: grant.ttlSeconds,
    };
  }

  // ── Participants ───────────────────────────────────────────────────────

  async updateCapabilities(
    roomName: string,
    identity: string,
    capabilities: RtcCapabilities,
  ): Promise<RtcApplyOutcome> {
    await this.admit('updateCapabilities', { roomName, identity });
    const participant = this.present.get(roomName)?.get(identity);
    if (participant === undefined) return 'not_connected';
    // The provider unpublishes a source at once when it is no longer allowed.
    const allowed = new Set(sourcesOf(capabilities));
    this.inRoom(roomName).set(identity, {
      ...participant,
      capabilities,
      publishing: participant.publishing.filter((source) => allowed.has(source)),
    });
    keep(this.capabilityLog, { roomName, identity, capabilities });
    return 'applied';
  }

  async removeParticipant(
    roomName: string,
    identity: string,
    options?: { readonly revokeTokensIssuedBefore?: Date },
  ): Promise<RtcApplyOutcome> {
    await this.admit('removeParticipant', { roomName, identity });
    if (this.present.get(roomName)?.delete(identity) !== true) return 'not_connected';
    keep(this.removedLog, {
      roomName,
      identity,
      revokeTokensIssuedBefore: options?.revokeTokensIssuedBefore ?? null,
    });
    return 'applied';
  }

  async muteParticipant(
    roomName: string,
    identity: string,
    sources: readonly RtcSource[],
  ): Promise<RtcApplyOutcome> {
    await this.admit('muteParticipant', { roomName, identity });
    const participant = this.present.get(roomName)?.get(identity);
    if (participant === undefined) return 'not_connected';
    this.inRoom(roomName).set(identity, {
      ...participant,
      publishing: participant.publishing.filter((source) => !sources.includes(source)),
    });
    keep(this.mutedLog, { roomName, identity, sources });
    return 'applied';
  }

  async listParticipants(roomName: string): Promise<readonly RtcParticipantObservation[]> {
    await this.admit('listParticipants', { roomName });
    return this.observed(roomName);
  }

  async getParticipant(
    roomName: string,
    identity: string,
  ): Promise<RtcParticipantObservation | null> {
    await this.admit('getParticipant', { roomName, identity });
    return this.present.get(roomName)?.get(identity) ?? null;
  }

  // ── Every call's way in ────────────────────────────────────────────────

  /** Logs the call, waits at its gate if one is held, then fails it if a failure is scripted. */
  private async admit(
    operation: RtcOperation,
    detail: Omit<FakeRtcCall, 'operation' | 'at'>,
  ): Promise<void> {
    keep(this.callLog, { operation, ...detail, at: this.clock.now() });
    const gate = this.gates.get(operation);
    if (gate !== undefined) await gate.arrive();
    const failure =
      this.scripted.get(operation)?.shift() ?? (this.unavailable ? 'unavailable' : null);
    if (failure === 'unavailable') throw new RtcUnavailableError(operation);
    if (failure === 'fault') throw new Error(`The media provider refused ${operation}.`);
  }

  private inRoom(roomName: string): Map<string, RtcParticipantObservation> {
    const room = this.present.get(roomName) ?? new Map<string, RtcParticipantObservation>();
    this.present.set(roomName, room);
    return room;
  }
}

/** Appends to a log, dropping the oldest entries beyond the bound. */
function keep<T>(log: T[], entry: T): void {
  log.push(entry);
  if (log.length > FAKE_RTC_LOG_LIMIT) log.splice(0, log.length - FAKE_RTC_LOG_LIMIT);
}
