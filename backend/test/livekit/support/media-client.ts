import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  dispose,
  type LocalTrack,
} from '@livekit/rtc-node';

/** A join ticket's media half, as `/join` answers it. */
export interface MediaTicket {
  readonly url: string;
  readonly token: string;
}

/** What a client may try to publish: the sources the application grants, and nothing else. */
export type Publishable = 'microphone' | 'screen_share';

/**
 * A real WebRTC participant — LiveKit's own Node client (`@livekit/rtc-node`,
 * a devDependency used under test/livekit/ only), connected with a ticket
 * exactly as an app would: the URL and token, nothing else. It publishes
 * real tracks — 10 ms of silence at a time for a microphone, a blank 64×64
 * frame for a screen — and never learns anything the server did not say.
 */
export class MediaClient {
  private readonly feeds: Array<ReturnType<typeof setInterval>> = [];

  private constructor(readonly room: Room) {}

  /** Connects with `ticket`, or rejects with the client's own error — a refusal, say. */
  static async connect(ticket: MediaTicket): Promise<MediaClient> {
    const room = new Room();
    try {
      await room.connect(ticket.url, ticket.token, { autoSubscribe: false, dynacast: false });
    } catch (error) {
      await room.disconnect().catch(() => undefined);
      throw error;
    }
    return new MediaClient(room);
  }

  get identity(): string {
    return this.local().identity;
  }

  get name(): string | undefined {
    return this.local().name;
  }

  /**
   * Starts publishing `source`. The answer never rejects: a track the server
   * refuses is not answered at all (the client gives up after its own
   * timeout), so what happened is read from the server (`ServerView`).
   */
  publish(source: Publishable): { readonly outcome: Promise<'published' | 'failed'> } {
    const options = new TrackPublishOptions();
    let track: LocalTrack;
    if (source === 'microphone') {
      const audio = new AudioSource(48_000, 1);
      track = LocalAudioTrack.createAudioTrack('microphone', audio);
      options.source = TrackSource.SOURCE_MICROPHONE;
      this.feed(10, () => {
        void audio.captureFrame(new AudioFrame(new Int16Array(480), 48_000, 1, 480)).catch(() => {
          // A frame after the track stopped: nothing to feed.
        });
      });
    } else {
      const video = new VideoSource(64, 64);
      track = LocalVideoTrack.createVideoTrack('screen', video);
      options.source = TrackSource.SOURCE_SCREENSHARE;
      const frame = new VideoFrame(new Uint8Array(64 * 64 * 4), 64, 64, VideoBufferType.RGBA);
      this.feed(50, () => video.captureFrame(frame));
    }
    return {
      outcome: this.local()
        .publishTrack(track, options)
        .then(
          () => 'published' as const,
          () => 'failed' as const,
        ),
    };
  }

  /** Leaves the room; a publish still waiting for an answer fails at once. */
  async disconnect(): Promise<void> {
    for (const feed of this.feeds.splice(0)) clearInterval(feed);
    await this.room.disconnect();
  }

  private feed(everyMs: number, frame: () => void): void {
    this.feeds.push(setInterval(frame, everyMs).unref());
  }

  private local() {
    const local = this.room.localParticipant;
    if (local === undefined) throw new Error('The media client is not connected.');
    return local;
  }
}

/**
 * The clients a test file opens, all closed by `closeAll` in its afterAll —
 * and with them the client's native runtime (`dispose`), which would
 * otherwise keep the worker alive.
 */
export function mediaClients() {
  const open: MediaClient[] = [];
  return {
    async connect(ticket: MediaTicket): Promise<MediaClient> {
      const client = await MediaClient.connect(ticket);
      open.push(client);
      return client;
    },

    /** Why the server refused `ticket`, in the client's words; fails if it was admitted. */
    async refusal(ticket: MediaTicket): Promise<string> {
      let admitted: MediaClient;
      try {
        admitted = await MediaClient.connect(ticket);
      } catch (error) {
        return (error as Error).message;
      }
      const identity = admitted.identity;
      await admitted.disconnect();
      throw new Error(`The server admitted ${identity}.`);
    },

    async closeAll(): Promise<void> {
      for (const client of open.splice(0)) await client.disconnect().catch(() => undefined);
      await dispose();
    },
  };
}

export type MediaClients = ReturnType<typeof mediaClients>;
