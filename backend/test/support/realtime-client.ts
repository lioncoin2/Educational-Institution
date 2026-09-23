import type { IncomingMessage } from 'node:http';

import WebSocket from 'ws';

export type Frame = Record<string, unknown> & { readonly type: string };

/** The HTTP API's `MessageResponse` — also what `message.sent` carries. */
export interface WireMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly senderId: string;
  readonly body: string | null;
  readonly clientMessageId: string | null;
  readonly [key: string]: unknown;
}

const WAIT_MS = 3000;

/**
 * A real WebSocket client for the API suites: every frame it receives, in
 * order, and helpers to wait for one.
 */
export class TestSocket {
  readonly frames: Frame[] = [];
  private closedWith: { code: number; reason: string } | null = null;
  private readonly listeners = new Set<() => void>();

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this.frames.push(JSON.parse(textOf(data)) as Frame);
      this.notify();
    });
    ws.on('close', (code, reason) => {
      this.closedWith = { code, reason: reason.toString() };
      this.notify();
    });
    ws.on('error', () => undefined);
  }

  /** Opens a connection; rejects with the HTTP status if the handshake is refused. */
  static open(
    url: string,
    options: { origin?: string; autoPong?: boolean } = {},
  ): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        autoPong: options.autoPong ?? true,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      });
      const socket = new TestSocket(ws);
      ws.once('open', () => resolve(socket));
      ws.once('unexpected-response', (_request, response: IncomingMessage) => {
        reject(new HandshakeRefused(response.statusCode ?? 0, response.headers));
        ws.terminate();
      });
      ws.once('error', (error) => reject(error));
    });
  }

  /** Opens and authenticates; resolves with the `ready` frame or throws with the refusal. */
  static async signedIn(url: string, token: string): Promise<TestSocket> {
    const socket = await TestSocket.open(url);
    socket.send({ type: 'auth', token });
    const answer = await socket.waitFor((f) => f.type === 'ready' || f.type === 'error');
    if (answer.type !== 'ready') throw new Error(`authentication refused: ${String(answer.code)}`);
    return socket;
  }

  get closed(): { code: number; reason: string } | null {
    return this.closedWith;
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  sendRaw(data: string | Buffer): void {
    this.ws.send(data);
  }

  ofType(type: string): Frame[] {
    return this.frames.filter((frame) => frame.type === type);
  }

  /** The first frame, received already or yet to come, that matches. */
  async waitFor(match: (frame: Frame) => boolean, timeoutMs = WAIT_MS): Promise<Frame> {
    const found = await this.until(() => this.frames.find(match), timeoutMs);
    if (found === undefined) throw new Error('timed out waiting for a frame');
    return found;
  }

  /** Waits until at least `count` frames of this type have arrived. */
  async waitForCount(type: string, count: number, timeoutMs = WAIT_MS): Promise<Frame[]> {
    const done = await this.until(
      () => (this.ofType(type).length >= count ? true : undefined),
      timeoutMs,
    );
    if (done === undefined) {
      throw new Error(`timed out: ${this.ofType(type).length}/${count} ${type} frames`);
    }
    return this.ofType(type);
  }

  async waitForClose(timeoutMs = WAIT_MS): Promise<{ code: number; reason: string }> {
    const closed = await this.until(() => this.closedWith ?? undefined, timeoutMs);
    if (closed === undefined) throw new Error('timed out waiting for the connection to close');
    return closed;
  }

  close(): Promise<void> {
    if (this.closedWith !== null) return Promise.resolve();
    this.ws.close();
    return this.waitForClose().then(() => undefined);
  }

  /** Drops the connection without a closing handshake — a phone losing its network. */
  kill(): void {
    this.ws.terminate();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private until<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
    const now = probe();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise((resolve) => {
      const listener = () => {
        const value = probe();
        if (value === undefined) return;
        cleanup();
        resolve(value);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      this.listeners.add(listener);
    });
  }
}

function textOf(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export class HandshakeRefused extends Error {
  constructor(
    readonly status: number,
    readonly headers: IncomingMessage['headers'],
  ) {
    super(`handshake refused with ${status}`);
  }
}

/**
 * The client-side reconciliation rules, stated once in TypeScript so the
 * backend suites can prove the protocol supports them end to end (the
 * Flutter client implements the same rules, and has its own tests):
 *
 *   - the server's sequence is the order; nothing else is;
 *   - a message already held (by id) is a duplicate and changes nothing;
 *   - `contiguousThrough` is the highest sequence with every earlier one
 *     held; a message beyond `contiguousThrough + 1` is held, but marks a gap;
 *   - a gap is filled over HTTP, paging `after` the contiguous mark — never
 *     from the socket.
 */
export class ConversationMirror {
  private readonly bySequence = new Map<number, WireMessage>();
  private readonly ids = new Set<string>();
  contiguousThrough = 0;
  /** Every `after` cursor catch-up asked the server for. */
  readonly catchUps: number[] = [];

  constructor(
    readonly conversationId: string,
    private readonly fetchAfter: (
      after: number,
    ) => Promise<{ items: WireMessage[]; hasNewer: boolean }>,
  ) {}

  /** Everything through this sequence is already accounted for (an initial page, say). */
  baselineAt(sequence: number): void {
    this.contiguousThrough = Math.max(this.contiguousThrough, sequence);
    while (this.bySequence.has(this.contiguousThrough + 1)) this.contiguousThrough += 1;
  }

  get messages(): WireMessage[] {
    return [...this.bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  }

  get hasGap(): boolean {
    return [...this.bySequence.keys()].some((sequence) => sequence > this.contiguousThrough);
  }

  /** Applies one `message.sent` frame. */
  receive(frame: Frame): 'merged' | 'duplicate' | 'gap' | 'ignored' {
    if (frame.type !== 'message.sent' || frame.conversationId !== this.conversationId) {
      return 'ignored';
    }
    const message = frame.message as WireMessage;
    if (typeof message?.id !== 'string' || message.sequence !== frame.sequence) return 'ignored';
    if (this.ids.has(message.id)) return 'duplicate';
    this.merge([message]);
    return this.hasGap ? 'gap' : 'merged';
  }

  /** Pages forward from the contiguous mark until the server has nothing newer. */
  async catchUp(): Promise<void> {
    for (;;) {
      const after = this.contiguousThrough;
      this.catchUps.push(after);
      const page = await this.fetchAfter(after);
      this.merge(page.items);
      if (!page.hasNewer || page.items.length === 0) return;
    }
  }

  private merge(messages: readonly WireMessage[]): void {
    for (const message of messages) {
      if (this.ids.has(message.id)) continue;
      this.ids.add(message.id);
      this.bySequence.set(message.sequence, message);
    }
    while (this.bySequence.has(this.contiguousThrough + 1)) this.contiguousThrough += 1;
  }
}
