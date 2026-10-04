/**
 * P8 load harness — the media driver: the rtc-node ADAPTER for the driver port
 * defined in test/load/mp/driver.ts. It is the ONLY load-harness file that names
 * LiveKit's WebRTC client (`@livekit/rtc-node`); like
 * test/livekit/support/media-client.ts it lives under test/livekit/, so the
 * architecture test (test/architecture/livekit-suite.spec.ts) stays satisfied.
 * Nothing under test/load/ imports the client; the worker reaches this module
 * by dynamic import, only on a real run.
 *
 * A LoadParticipant connects as a listener (subscribe-only) or as a publisher of
 * a 440 Hz tone (or a synthetic screen share), with an EXPLICIT ICE mode
 * (P8.4 §17): `turn-free` passes a non-empty STUN-only server list — the SDK
 * merges the server's TURN servers only when the client list is empty
 * (rust-sdks livekit-ffi/v0.12.73 rtc_session.rs:2547-2558) — and `relay`
 * forces TURN for the positive control. It maps room events and
 * `getRtcStats()` to the port's plain data. It judges nothing.
 */
import {
  DisconnectReason,
  IceCandidatePairState,
  IceCandidateType,
  type RtcStats,
  TrackKind,
  VideoEncoding,
} from '@livekit/rtc-ffi-bindings';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  ContinualGatheringPolicy,
  IceServer,
  IceTransportType,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  type RoomOptions,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoCodec,
  VideoFrame,
  VideoSource,
  dispose,
} from '@livekit/rtc-node';

import {
  type ConnectOptions,
  type LoadParticipantLike,
  type MediaStatsSnapshot,
  type ParticipantEvent,
  type ScreenSpec,
  type SelectedPair,
} from '../../load/mp/driver';
import { type CandidateType, type IceConfig, type MediaTicket } from '../../load/mp/types';

/** The publisher's tone; `queueMs` bounds the native source queue (publisher-side latency). */
const TONE = {
  hertz: 440,
  amplitude: 4_000,
  sampleRate: 48_000,
  samplesPer10Ms: 480,
  queueMs: 100,
} as const;
const DEFAULT_SCREEN: ScreenSpec = { width: 640, height: 360, fps: 15, maxBitrateKbps: 600 };
/** A pair timestamp further than this from now is in an unknown unit and is ignored. */
const PLAUSIBLE_TS_WINDOW_MS = 24 * 3_600_000;

/** The rtcConfig for an explicit ICE mode. Refuses anything that could reach TURN in turn-free mode. */
export function rtcConfigFor(ice: IceConfig): NonNullable<RoomOptions['rtcConfig']> {
  if (ice.mode === 'relay')
    return {
      iceTransportType: IceTransportType.TRANSPORT_RELAY,
      continualGatheringPolicy: ContinualGatheringPolicy.GATHER_ONCE,
      iceServers: [],
    };
  const urls = [...ice.stunUrls];
  if (urls.length === 0 || urls.some((u) => !u.startsWith('stun:')))
    throw new Error('turn-free ICE needs a non-empty, STUN-only server list');
  return {
    iceTransportType: IceTransportType.TRANSPORT_ALL,
    continualGatheringPolicy: ContinualGatheringPolicy.GATHER_CONTINUALLY,
    iceServers: [new IceServer({ urls })],
  };
}

const CANDIDATE: Readonly<Record<number, CandidateType>> = {
  [IceCandidateType.HOST]: 'host',
  [IceCandidateType.SRFLX]: 'srflx',
  [IceCandidateType.PRFLX]: 'prflx',
  [IceCandidateType.RELAY]: 'relay',
};
const candidateType = (t: IceCandidateType | undefined): CandidateType =>
  t === undefined ? 'unknown' : (CANDIDATE[t] ?? 'unknown');

/** Reduces one getRtcStats() list to the port's snapshot (pure over the bindings' data). */
export function snapshotOf(list: readonly RtcStats[], nowMs: number): MediaStatsSnapshot {
  const inbound = { found: false, packetsReceived: 0, packetsLost: 0, jitterSec: 0 };
  const outbound = { found: false, packetsSent: 0 };
  const local = new Map<string, { type: CandidateType; protocol: string }>();
  const remote = new Map<string, { type: CandidateType; port: number | null }>();
  let best: { localId: string; remoteId: string; bytes: number; last: number | null } | null = null;
  for (const s of list) {
    switch (s.stats.case) {
      case 'inboundRtp': {
        if (s.stats.value.stream?.kind !== 'audio') break;
        const r = s.stats.value.received;
        inbound.found = true;
        inbound.packetsReceived += Number(r?.packetsReceived ?? 0n);
        inbound.packetsLost += Number(r?.packetsLost ?? 0n);
        inbound.jitterSec = Math.max(inbound.jitterSec, r?.jitter ?? 0);
        break;
      }
      case 'outboundRtp':
        if (s.stats.value.stream?.kind !== 'audio') break;
        outbound.found = true;
        outbound.packetsSent += Number(s.stats.value.sent?.packetsSent ?? 0n);
        break;
      case 'localCandidate': {
        const c = s.stats.value.candidate;
        local.set(s.stats.value.rtc?.id ?? '', {
          type: candidateType(c?.candidateType),
          protocol: c?.protocol ?? '',
        });
        break;
      }
      case 'remoteCandidate': {
        const c = s.stats.value.candidate;
        remote.set(s.stats.value.rtc?.id ?? '', {
          type: candidateType(c?.candidateType),
          port: c?.port ?? null,
        });
        break;
      }
      case 'candidatePair': {
        const p = s.stats.value.candidatePair;
        if (!p?.nominated || p.state !== IceCandidatePairState.PAIR_SUCCEEDED) break;
        const bytes = Number(p.bytesReceived ?? 0n) + Number(p.bytesSent ?? 0n);
        if (best && best.bytes >= bytes) break;
        const last = p.lastPacketReceivedTimestamp ?? 0;
        best = {
          localId: p.localCandidateId ?? '',
          remoteId: p.remoteCandidateId ?? '',
          bytes,
          last: last > 0 && Math.abs(nowMs - last) < PLAUSIBLE_TS_WINDOW_MS ? last : null,
        };
        break;
      }
      default:
        break;
    }
  }
  let selectedPair: SelectedPair | null = null;
  if (best) {
    const l = local.get(best.localId);
    const r = remote.get(best.remoteId);
    selectedPair = {
      protocol: l?.protocol ?? '',
      localType: l?.type ?? 'unknown',
      remoteType: r?.type ?? 'unknown',
      remotePort: r?.port ?? null,
      lastPacketReceivedMs: best.last,
    };
  }
  const localCandidateTypes = [...new Set([...local.values()].map((c) => c.type))];
  return {
    statsTsMs: nowMs,
    inbound: inbound.found
      ? {
          packetsReceived: inbound.packetsReceived,
          packetsLost: inbound.packetsLost,
          jitterSec: inbound.jitterSec,
        }
      : null,
    outbound: outbound.found ? { packetsSent: outbound.packetsSent } : null,
    selectedPair,
    localCandidateTypes,
  };
}

export class LoadParticipant implements LoadParticipantLike {
  private readonly feeds: Array<ReturnType<typeof setInterval>> = [];
  private audio: AudioSource | null = null;
  private closed = false;
  private listener: ((e: ParticipantEvent) => void) | null = null;
  /** Events raised before the worker registered its listener (e.g. during connect). */
  private readonly early: ParticipantEvent[] = [];

  private constructor(
    readonly room: Room,
    private readonly subscriber: boolean,
  ) {
    const raise = (e: ParticipantEvent): void => {
      if (this.listener) this.listener(e);
      else this.early.push(e);
    };
    room
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) =>
        raise({
          kind: 'trackSubscribed',
          trackSid: publication.sid ?? track.sid ?? '',
          publisher: participant.identity,
        }),
      )
      .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) =>
        raise({
          kind: 'trackUnsubscribed',
          trackSid: publication.sid ?? track.sid ?? '',
          publisher: participant.identity,
        }),
      )
      .on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant, reason) =>
        raise({
          kind: 'trackSubscriptionFailed',
          trackSid,
          publisher: participant.identity,
          reason: reason ?? null,
        }),
      )
      .on(RoomEvent.ParticipantDisconnected, (participant) =>
        raise({ kind: 'participantDisconnected', identity: participant.identity }),
      )
      .on(RoomEvent.Disconnected, (reason) =>
        raise({ kind: 'disconnected', reason: DisconnectReason[reason] ?? String(reason) }),
      )
      .on(RoomEvent.Reconnecting, () => raise({ kind: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => raise({ kind: 'reconnected' }));
  }

  static async connect(ticket: MediaTicket, opts: ConnectOptions): Promise<LoadParticipant> {
    const room = new Room();
    const participant = new LoadParticipant(room, opts.subscribe);
    const options: RoomOptions = {
      autoSubscribe: opts.subscribe,
      dynacast: false,
      rtcConfig: rtcConfigFor(opts.ice),
    };
    try {
      await room.connect(ticket.url, ticket.token, options);
    } catch (error) {
      await room.disconnect().catch(() => undefined);
      throw error;
    }
    return participant;
  }

  onEvent(listener: (e: ParticipantEvent) => void): void {
    this.listener = listener;
    for (const e of this.early.splice(0)) listener(e);
  }

  async stats(): Promise<MediaStatsSnapshot> {
    const s = await this.room.getRtcStats();
    const primary = this.subscriber ? s.subscriberStats : s.publisherStats;
    return snapshotOf(
      [...primary, ...(this.subscriber ? s.publisherStats : s.subscriberStats)],
      Date.now(),
    );
  }

  /** Publishes a continuous 440 Hz tone as a microphone track: dtx off (a tone must never pause), RED on. */
  async publishMicrophone(): Promise<{ trackSid: string }> {
    const source = new AudioSource(TONE.sampleRate, 1, TONE.queueMs);
    this.audio = source;
    const track = LocalAudioTrack.createAudioTrack('microphone', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    options.dtx = false;
    options.red = true;
    void this.pumpTone(source);
    const publication = await this.local().publishTrack(track, options);
    return { trackSid: publication.sid ?? '' };
  }

  /**
   * Feeds the tone at the SDK's real-time pace: `captureFrame` resolves only once the native
   * queue (TONE.queueMs) has room, so awaiting each frame IS the pacing. A JS timer drifts,
   * starves the queue and puts silence and phase jumps into the tone (P8.4 pre-commit real
   * validation: tone ratio 0.01 over 1 s). Ends when the participant disconnects.
   */
  private async pumpTone(source: AudioSource): Promise<void> {
    let sample = 0;
    try {
      while (!this.closed) {
        const frame = new Int16Array(TONE.samplesPer10Ms);
        for (let i = 0; i < frame.length; i += 1, sample += 1) {
          frame[i] = Math.round(
            TONE.amplitude * Math.sin((2 * Math.PI * TONE.hertz * sample) / TONE.sampleRate),
          );
        }
        await source.captureFrame(new AudioFrame(frame, TONE.sampleRate, 1, TONE.samplesPer10Ms));
      }
    } catch {
      // the source was closed by disconnect()
    }
  }

  /**
   * Publishes a screen-share video track at `spec`'s resolution/fps, with the
   * encoder bitrate CEILED at spec.maxBitrateKbps. Each frame is a deterministic
   * high-entropy pattern, so the encoder sustains near the ceiling (a BUSY
   * screen share — an upper bound; the achieved bitrate must be MEASURED).
   */
  async publishScreenShare(spec: ScreenSpec = DEFAULT_SCREEN): Promise<void> {
    const source = new VideoSource(spec.width, spec.height);
    const track = LocalVideoTrack.createVideoTrack('screen', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_SCREENSHARE;
    options.videoCodec = VideoCodec.VP8;
    options.videoEncoding = new VideoEncoding({
      maxBitrate: BigInt(spec.maxBitrateKbps * 1000),
      maxFramerate: spec.fps,
    });
    const buffer = new Uint8Array(spec.width * spec.height * 4);
    const words = new Uint32Array(buffer.buffer);
    const frame = new VideoFrame(buffer, spec.width, spec.height, VideoBufferType.RGBA);
    let seed = 0x9e3779b9;
    this.feed(Math.round(1000 / spec.fps), () => {
      let x = seed >>> 0;
      for (let i = 0; i < words.length; i += 1) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        words[i] = x >>> 0;
      }
      seed = x >>> 0;
      source.captureFrame(frame);
    });
    await this.local().publishTrack(track, options);
  }

  /** Decoded mono PCM of the first subscribed remote audio track, for `durationMs`. */
  async captureAudio(
    durationMs: number,
  ): Promise<{ samples: Int16Array; sampleRate: number } | null> {
    for (const remote of this.room.remoteParticipants.values()) {
      for (const publication of remote.trackPublications.values()) {
        const track = publication.track;
        if (!track || track.kind !== TrackKind.KIND_AUDIO) continue;
        const reader = new AudioStream(track, {
          sampleRate: TONE.sampleRate,
          numChannels: 1,
        }).getReader();
        const chunks: Int16Array[] = [];
        let total = 0;
        const wanted = (TONE.sampleRate * durationMs) / 1000;
        try {
          while (total < wanted) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value.data);
            total += value.data.length;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const samples = new Int16Array(total);
        let at = 0;
        for (const c of chunks) {
          samples.set(c, at);
          at += c.length;
        }
        return { samples, sampleRate: TONE.sampleRate };
      }
    }
    return null;
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    for (const feed of this.feeds.splice(0)) clearInterval(feed);
    await this.room.disconnect().catch(() => undefined);
    await this.audio?.close().catch(() => undefined);
    this.audio = null;
  }

  private feed(everyMs: number, frame: () => void): void {
    this.feeds.push(setInterval(frame, everyMs).unref());
  }

  private local() {
    const local = this.room.localParticipant;
    if (local === undefined) throw new Error('participant is not connected');
    return local;
  }
}

/** Frees the native rtc-node runtime; the harness calls this once at shutdown. */
export async function disposeMedia(): Promise<void> {
  await dispose();
}
