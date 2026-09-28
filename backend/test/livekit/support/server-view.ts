import { RoomServiceClient, TrackSource, type ParticipantInfo } from 'livekit-server-sdk';

import { credentialsIn } from '../../support/log-capture';
import { serverLog, type ServerLogLine, type TestServer } from './test-servers';

/**
 * What the server itself holds, read through LiveKit's own room service
 * with the server's credentials — never through the adapter under test, so
 * no assertion takes the application's word for what happened on the wire.
 */
export class ServerView {
  readonly rooms: RoomServiceClient;

  constructor(readonly server: TestServer) {
    this.rooms = new RoomServiceClient(server.httpUrl, server.apiKey, server.apiSecret, {
      requestTimeout: 10,
      failover: false,
    });
  }

  /** The rooms the server holds whose names start with `prefix`. */
  async roomsNamed(prefix: string): Promise<string[]> {
    return (await this.rooms.listRooms())
      .map((room) => room.name)
      .filter((name) => name.startsWith(prefix))
      .sort();
  }

  /** Who is in `room`, by identity. */
  async identities(room: string): Promise<string[]> {
    return (await this.rooms.listParticipants(room)).map((p) => p.identity).sort();
  }

  async participant(room: string, identity: string): Promise<ParticipantInfo | undefined> {
    return (await this.rooms.listParticipants(room)).find((p) => p.identity === identity);
  }

  /** The sources of the tracks `identity` publishes in `room` now. */
  async publishing(room: string, identity: string): Promise<TrackSource[]> {
    return ((await this.participant(room, identity))?.tracks ?? []).map((track) => track.source);
  }

  /** Waits until the server lists `identity` publishing a track from `source`. */
  async published(room: string, identity: string, source: TrackSource): Promise<void> {
    await eventually(`${identity} publishing ${TrackSource[source]} in ${room}`, async () =>
      (await this.publishing(room, identity)).includes(source),
    );
  }

  /** Waits until the server no longer lists `identity` publishing a track from `source`. */
  async unpublished(room: string, identity: string, source: TrackSource): Promise<void> {
    await eventually(
      `${identity} no longer publishing ${TrackSource[source]} in ${room}`,
      async () => !(await this.publishing(room, identity)).includes(source),
    );
  }

  /**
   * Where the server's log stands now: a line `logged` and `refused` find
   * must come after it, so a check repeated for the same participant never
   * passes on an earlier line.
   */
  mark(): number {
    return serverLog(this.server).length;
  }

  /** Waits until the server logs, after `mark`, a line that `matches` — and answers it. */
  async logged(
    what: string,
    mark: number,
    matches: (line: ServerLogLine) => boolean,
  ): Promise<ServerLogLine> {
    return eventually(what, () => serverLog(this.server).slice(mark).find(matches));
  }

  /**
   * Waits until the server has refused, after `mark`, a track `identity`
   * asked to publish — its own log line, written as it answers the request
   * NOT_ALLOWED (SRV pkg/rtc/participant.go:1364-1373) — then answers what
   * `identity` publishes: the refused track never appears.
   */
  async refused(
    room: string,
    identity: string,
    kind: 'AUDIO' | 'VIDEO',
    mark: number,
  ): Promise<TrackSource[]> {
    await this.logged(
      `the server refusing ${identity} a ${kind} track in ${room}`,
      mark,
      (line) =>
        line.msg === 'no permission to publish track' &&
        line.room === room &&
        line.participant === identity &&
        line.kind === kind,
    );
    return this.publishing(room, identity);
  }

  /** The server's log so far, as text. */
  logText(): string {
    return serverLog(this.server)
      .map((line) => JSON.stringify(line))
      .join('\n');
  }
}

/**
 * Every credential written in `text`: a JWT (`credentialsIn`), an
 * Authorization header, or one of `secrets`. Empty when there is none.
 */
export function leakedCredentials(text: string, secrets: readonly string[]): string[] {
  return [
    ...credentialsIn(text),
    ...(/Bearer /i.test(text) ? ['an Authorization header'] : []),
    ...secrets.filter((secret) => text.includes(secret)).map(() => 'a configured secret'),
  ];
}

/**
 * Polls `probe` every 25 ms until it answers something truthy, and answers
 * that — or fails once `timeoutMs` has passed, naming `what` it waited for.
 */
export async function eventually<T>(
  what: string,
  probe: () => T | Promise<T>,
  timeoutMs = 10_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Waited ${timeoutMs} ms for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
