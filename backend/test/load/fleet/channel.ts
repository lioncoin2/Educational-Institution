/**
 * P8.4 — NDJSON framing for the controller ⇄ agent channel (design §3). One
 * reader per byte stream: splits lines, enforces MAX_LINE_BYTES BEFORE a line
 * is buffered past the cap (agent input is untrusted), decodes each line with
 * the protocol's validator and reports protocol errors instead of throwing.
 * Used on both ends (controller reads agent stdout; agent reads its stdin).
 */
import { type Readable, type Writable } from 'node:stream';

import {
  type AgentMessage,
  type ControllerMessage,
  type Decoded,
  MAX_LINE_BYTES,
  encode,
} from './protocol';

export interface LineHandlers<T> {
  readonly onMessage: (msg: T) => void;
  readonly onProtocolError: (error: string) => void;
  readonly onEnd: () => void;
}

/** Reads NDJSON from `stream`, decoding each line with `decode`. */
export function readLines<T>(
  stream: Readable,
  decode: (line: string) => Decoded<T>,
  handlers: LineHandlers<T>,
  maxBytes = MAX_LINE_BYTES,
): void {
  let pending = '';
  let broken = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    if (broken) return;
    pending += chunk;
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim() !== '') {
        const decoded = decode(line);
        if (decoded.ok) handlers.onMessage(decoded.msg);
        else handlers.onProtocolError(decoded.error);
      }
      nl = pending.indexOf('\n');
    }
    if (Buffer.byteLength(pending, 'utf8') > maxBytes) {
      broken = true;
      pending = '';
      handlers.onProtocolError('line too long');
    }
  });
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    handlers.onEnd();
  };
  stream.once('end', end);
  stream.once('close', end);
  // A broken read side is the end of the link, reported once — never an uncaught exception.
  stream.on('error', end);
}

/** Writes one message as a line; false when the stream is gone. */
export function writeMessage(stream: Writable, msg: ControllerMessage | AgentMessage): boolean {
  if (stream.destroyed || !stream.writable) return false;
  stream.write(encode(msg));
  return true;
}
