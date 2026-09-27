import type { IncomingMessage } from 'node:http';

import WebSocket from 'ws';

import { eventually } from './server-view';

/**
 * A bare signalling connection to LiveKit's `/rtc`, opened as any client
 * could open one with a token it was handed — here with the `publish`
 * connect parameter, which makes the server join a SECOND standard
 * participant named `<identity>#<publish>` from any publish-capable token
 * (SRV pkg/service/utils.go:378-387). It negotiates no media: it only holds
 * that participant in the room, as the audit's probe did.
 */
export class RawSignalling {
  private closedWith: number | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.on('close', (code) => {
      this.closedWith = code;
    });
    socket.on('error', () => undefined);
  }

  /** Opens `/rtc` with `publish` set; answers the HTTP status if the server refuses the upgrade. */
  static open(
    url: string,
    token: string,
    publish: string,
  ): Promise<RawSignalling | { readonly refused: number }> {
    const query = new URLSearchParams({
      access_token: token,
      auto_subscribe: '1',
      protocol: '15',
      publish,
    });
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${url}/rtc?${query.toString()}`);
      socket.once('open', () => resolve(new RawSignalling(socket)));
      socket.once('unexpected-response', (_request, response: IncomingMessage) => {
        resolve({ refused: response.statusCode ?? 0 });
        socket.terminate();
      });
      socket.once('error', reject);
    });
  }

  /** Waits for the server to close the connection, and answers its close code. */
  async closedByServer(): Promise<number> {
    return eventually('the server closing the signalling connection', () => this.closedWith);
  }

  close(): void {
    this.socket.terminate();
  }
}
