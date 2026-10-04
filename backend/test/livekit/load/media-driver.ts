/**
 * P8 load harness — the media driver. This is the ONLY new file that names
 * LiveKit's WebRTC client (`@livekit/rtc-node`); like test/livekit/support/
 * media-client.ts it lives under test/livekit/ so the architecture test
 * (test/architecture/livekit-suite.spec.ts) stays satisfied — nothing under
 * test/load/ imports the client directly; it reaches a LoadParticipant through
 * this module by dynamic import, only on a real run.
 *
 * A LoadParticipant is a deliberately lean synthetic participant: connect as a
 * listener (subscribe-only) or as a publisher of a 440 Hz audio tone or a
 * synthetic screen-share frame, with optional forced TURN relay, and a clean
 * shutdown. It intentionally does not re-implement media-client.ts's assertion
 * helpers — it exists to create load, not to verify behaviour.
 */
import { VideoEncoding } from '@livekit/rtc-ffi-bindings';
import {
  AudioFrame,
  AudioSource,
  ContinualGatheringPolicy,
  IceTransportType,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  type RoomOptions,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoCodec,
  VideoFrame,
  VideoSource,
  dispose,
} from '@livekit/rtc-node';

export interface Ticket {
  readonly url: string;
  readonly token: string;
}

export interface ConnectOptions {
  /** Subscribe to others' tracks (a listener hears the room). */
  readonly subscribe: boolean;
  /** Force all media through TURN (iceTransportType = RELAY). */
  readonly relay: boolean;
}

/** A screen-share source: resolution, framerate and an encoder bitrate ceiling. */
export interface ScreenSpec {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly maxBitrateKbps: number;
}

const TONE = { hertz: 440, amplitude: 4_000, sampleRate: 48_000, samplesPer10Ms: 480 } as const;
const DEFAULT_SCREEN: ScreenSpec = { width: 640, height: 360, fps: 15, maxBitrateKbps: 600 };

/** The rtcConfig that pins a connection to relay-only candidates. */
function relayConfig(): RoomOptions['rtcConfig'] {
  return {
    iceTransportType: IceTransportType.TRANSPORT_RELAY,
    continualGatheringPolicy: ContinualGatheringPolicy.GATHER_ONCE,
    iceServers: [],
  };
}

export class LoadParticipant {
  private readonly feeds: Array<ReturnType<typeof setInterval>> = [];

  private constructor(readonly room: Room) {}

  static async connect(ticket: Ticket, opts: ConnectOptions): Promise<LoadParticipant> {
    const room = new Room();
    const options: RoomOptions = { autoSubscribe: opts.subscribe, dynacast: false };
    if (opts.relay) options.rtcConfig = relayConfig();
    try {
      await room.connect(ticket.url, ticket.token, options);
    } catch (error) {
      await room.disconnect().catch(() => undefined);
      throw error;
    }
    return new LoadParticipant(room);
  }

  get identity(): string {
    const local = this.room.localParticipant;
    if (local === undefined) throw new Error('participant is not connected');
    return local.identity;
  }

  /** Publishes a continuous 440 Hz tone as a microphone track. */
  async publishMicrophone(): Promise<void> {
    const source = new AudioSource(TONE.sampleRate, 1);
    const track = LocalAudioTrack.createAudioTrack('microphone', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    let sample = 0;
    this.feed(10, () => {
      const frame = new Int16Array(TONE.samplesPer10Ms);
      for (let i = 0; i < frame.length; i += 1, sample += 1) {
        frame[i] = Math.round(
          TONE.amplitude * Math.sin((2 * Math.PI * TONE.hertz * sample) / TONE.sampleRate),
        );
      }
      void source
        .captureFrame(new AudioFrame(frame, TONE.sampleRate, 1, TONE.samplesPer10Ms))
        .catch(() => undefined);
    });
    await this.local().publishTrack(track, options);
  }

  /**
   * Publishes a screen-share video track at `spec`'s resolution/fps, with the
   * encoder bitrate CEILED at spec.maxBitrateKbps (rtc-node videoEncoding). Each
   * frame is filled with a deterministic word-wise xorshift pattern — high
   * entropy, so the encoder cannot compress it and sustains near the ceiling.
   *
   * This models a BUSY screen share (an upper bound). `maxBitrate` is a ceiling,
   * not a guarantee; real low-motion desktop capture sits well below it. The
   * achieved bitrate must be MEASURED (smoke test), never inferred from the
   * resolution (Q-P8-2, docs/p8.2-offbox-load-generator.md).
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

  async disconnect(): Promise<void> {
    for (const feed of this.feeds.splice(0)) clearInterval(feed);
    await this.room.disconnect().catch(() => undefined);
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
