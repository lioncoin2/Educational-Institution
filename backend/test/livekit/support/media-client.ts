import {
  AudioFrame,
  AudioSource,
  AudioStream,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource,
  dispose,
  type LocalTrack,
  type RemoteTrack,
} from '@livekit/rtc-node';

/** A join ticket's media half, as `/join` answers it. */
export interface MediaTicket {
  readonly url: string;
  readonly token: string;
}

/** What a client may try to publish: the sources the application grants, and nothing else. */
export type Publishable = 'microphone' | 'screen_share';

/** The topic every data packet and text the suite sends is sent on. */
export const SUITE_TOPIC = 'suite';

/** Something another participant sent this client, as it arrived. */
export interface Received {
  readonly kind: 'data' | 'text';
  readonly from: string | undefined;
  readonly text: string;
}

/** The tone a microphone carries: 440 Hz, loud enough to tell from silence at any codec setting. */
const TONE = { hertz: 440, amplitude: 4_000, sampleRate: 48_000, samplesPer10Ms: 480 } as const;

/**
 * A real WebRTC participant — LiveKit's own Node client (`@livekit/rtc-node`,
 * a devDependency used under test/livekit/ only), connected with a ticket
 * exactly as an app would: the URL and token, nothing else. It publishes
 * real tracks — a 440 Hz tone for a microphone, a blank 64×64 frame for a
 * screen — hears what it subscribes to, sends and receives data and text, and
 * never learns anything the server did not say.
 */
export class MediaClient {
  private readonly feeds: Array<ReturnType<typeof setInterval>> = [];
  /** Every data packet and text that reached this client, in order. */
  readonly received: Received[] = [];
  /** Why the client left the room — the server's reason, or its own leaving. */
  readonly ended: Promise<DisconnectReason>;

  private constructor(readonly room: Room) {
    this.ended = new Promise((resolve) => room.once(RoomEvent.Disconnected, resolve));
    room.on(RoomEvent.DataReceived, (payload, participant) => {
      this.received.push({
        kind: 'data',
        from: participant?.identity,
        text: Buffer.from(payload).toString('utf8'),
      });
    });
    room.registerTextStreamHandler(SUITE_TOPIC, (reader, { identity }) => {
      void reader
        .readAll()
        .then((text) => this.received.push({ kind: 'text', from: identity, text }));
    });
  }

  /**
   * Connects with `ticket`, or rejects with the client's own error — a
   * refusal, say. It subscribes to nothing unless `subscribe` asks it to.
   */
  static async connect(ticket: MediaTicket, subscribe = false): Promise<MediaClient> {
    const client = new MediaClient(new Room());
    try {
      await client.room.connect(ticket.url, ticket.token, {
        autoSubscribe: subscribe,
        dynacast: false,
      });
    } catch (error) {
      await client.room.disconnect().catch(() => undefined);
      throw error;
    }
    return client;
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
      const audio = new AudioSource(TONE.sampleRate, 1);
      track = LocalAudioTrack.createAudioTrack('microphone', audio);
      options.source = TrackSource.SOURCE_MICROPHONE;
      let sample = 0;
      this.feed(10, () => {
        const frame = new Int16Array(TONE.samplesPer10Ms);
        for (let i = 0; i < frame.length; i += 1, sample += 1) {
          const phase = (2 * Math.PI * TONE.hertz * sample) / TONE.sampleRate;
          frame[i] = Math.round(TONE.amplitude * Math.sin(phase));
        }
        void audio
          .captureFrame(new AudioFrame(frame, TONE.sampleRate, 1, TONE.samplesPer10Ms))
          .catch(() => {
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

  /**
   * Waits until this client — connected with `subscribe` — receives
   * `identity`'s microphone and hears sound in it, and answers the loudest
   * sample it heard. Fails after `timeoutMs` without sound: silence, no
   * track, or no subscription.
   */
  async heard(identity: string, timeoutMs = 10_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let track: RemoteTrack | undefined;
    while (track === undefined) {
      if (Date.now() >= deadline) throw new Error(`No microphone of ${identity} reached us.`);
      const publications = this.room.remoteParticipants.get(identity)?.trackPublications;
      track = [...(publications?.values() ?? [])].find(
        (publication) => publication.source === TrackSource.SOURCE_MICROPHONE,
      )?.track;
      if (track === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const reader = new AudioStream(track, TONE.sampleRate, 1).getReader();
    const timer = setTimeout(() => void reader.cancel(), Math.max(0, deadline - Date.now()));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`Heard no sound from ${identity}.`);
        const loudest = value.data.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
        if (loudest > TONE.amplitude / 4) return loudest;
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }

  /** Sends `text` as a reliable data packet on the suite's topic. Never awaited by a test. */
  sendData(text: string): Promise<'sent' | 'failed'> {
    return this.local()
      .publishData(Buffer.from(text, 'utf8'), { reliable: true, topic: SUITE_TOPIC })
      .then(
        () => 'sent' as const,
        () => 'failed' as const,
      );
  }

  /** Sends `text` as a text stream on the suite's topic. Never awaited by a test. */
  sendText(text: string): Promise<'sent' | 'failed'> {
    return this.local()
      .sendText(text, { topic: SUITE_TOPIC })
      .then(
        () => 'sent' as const,
        () => 'failed' as const,
      );
  }

  /** Asks the server to change this participant's own metadata or name. Never awaited by a test. */
  update(change: { readonly metadata: string } | { readonly name: string }): void {
    const local = this.local();
    const asked =
      'metadata' in change ? local.updateMetadata(change.metadata) : local.updateName(change.name);
    void asked.catch(() => undefined);
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

/** A disconnect reason by its name, for a readable assertion. */
export const reasonName = (reason: DisconnectReason): string =>
  DisconnectReason[reason] ?? String(reason);

/**
 * The clients a test file opens, all closed by `closeAll` in its afterAll —
 * and with them the client's native runtime (`dispose`), which would
 * otherwise keep the worker alive.
 */
export function mediaClients() {
  const open: MediaClient[] = [];
  return {
    async connect(ticket: MediaTicket, subscribe = false): Promise<MediaClient> {
      const client = await MediaClient.connect(ticket, subscribe);
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
