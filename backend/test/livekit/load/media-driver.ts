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

const TONE = { hertz: 440, amplitude: 4_000, sampleRate: 48_000, samplesPer10Ms: 480 } as const;
const SCREEN = { width: 320, height: 180, fps: 15 } as const;

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
   * Publishes a synthetic screen-share video track. NOTE: the frame is a solid
   * buffer at a modest resolution — enough to exercise a video forwarder, but
   * NOT bandwidth-representative of real 1080p screen content (Q-P8-2). Use a
   * real capture source before drawing screen-share bandwidth conclusions.
   */
  async publishScreenShare(): Promise<void> {
    const source = new VideoSource(SCREEN.width, SCREEN.height);
    const track = LocalVideoTrack.createVideoTrack('screen', source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_SCREENSHARE;
    const buffer = new Uint8Array(SCREEN.width * SCREEN.height * 4);
    const frame = new VideoFrame(buffer, SCREEN.width, SCREEN.height, VideoBufferType.RGBA);
    this.feed(Math.round(1000 / SCREEN.fps), () => {
      for (let i = 0; i < buffer.length; i += 4) buffer[i] = (buffer[i] ?? 0) + 7;
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
