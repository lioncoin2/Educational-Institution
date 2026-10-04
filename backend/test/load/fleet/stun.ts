/**
 * P8.4 — a minimal RFC 5389 STUN Binding responder, run IN-PROCESS by each
 * generator agent (design §17). Direct mode needs a NON-EMPTY, TURN-free client
 * ICE-server list (an empty list makes the SDK merge the SUT's TURN servers —
 * errata E2); this responder is that list's only entry. It answers Binding
 * Requests with the sender's XOR-MAPPED-ADDRESS and nothing else: no
 * authentication, no TURN, no third party, never the SUT. The agent owns the
 * socket and closes it; nothing here starts a timer.
 *
 * The codec is pure: parsing never throws (a datagram is untrusted input), and
 * building throws only on a caller's programming error.
 */
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { isIPv4, isIPv6 } from 'node:net';

const HEADER_BYTES = 20;
const TRANSACTION_ID_BYTES = 12;
const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_SOFTWARE = 0x8022;
const FAMILY_CODE = { IPv4: 0x01, IPv6: 0x02 } as const;
const SOFTWARE = 'p84-stun';

export interface BindingRequest {
  readonly transactionId: Buffer;
}

/**
 * A Binding Request (RFC 5389 §6): type 0x0001, the magic cookie, and a length
 * field that matches the datagram and is a multiple of 4. Attributes are
 * ignored. Anything else → null.
 */
export function parseBindingRequest(buf: Buffer): BindingRequest | null {
  if (buf.length < HEADER_BYTES) return null;
  const length = buf.readUInt16BE(2);
  if (buf.readUInt16BE(0) !== BINDING_REQUEST || buf.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  if (length % 4 !== 0 || length !== buf.length - HEADER_BYTES) return null;
  return { transactionId: Buffer.from(buf.subarray(8, HEADER_BYTES)) };
}

/** A Binding Success Response carrying XOR-MAPPED-ADDRESS (§15.2) and SOFTWARE (§15.10). */
export function buildBindingSuccess(
  transactionId: Buffer,
  address: string,
  port: number,
  family: 'IPv4' | 'IPv6',
): Buffer {
  if (transactionId.length !== TRANSACTION_ID_BYTES)
    throw new RangeError(`transaction id must be ${TRANSACTION_ID_BYTES} bytes`);
  if (!isPort(port)) throw new RangeError(`invalid port ${port}`);
  const body = Buffer.concat([
    attribute(ATTR_XOR_MAPPED_ADDRESS, xorMappedAddress(transactionId, address, port, family)),
    attribute(ATTR_SOFTWARE, Buffer.from(SOFTWARE, 'utf8')),
  ]);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16BE(BINDING_SUCCESS, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, body]);
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 0xffff;
}

/** Type-length-value with the value zero-padded to a 4-byte boundary (§15). */
function attribute(type: number, value: Buffer): Buffer {
  const out = Buffer.alloc(4 + ((value.length + 3) & ~3));
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(value.length, 2);
  value.copy(out, 4);
  return out;
}

/** Port XOR the cookie's high 16 bits; address XOR the cookie (‖ transaction id for IPv6). */
function xorMappedAddress(
  transactionId: Buffer,
  address: string,
  port: number,
  family: 'IPv4' | 'IPv6',
): Buffer {
  const raw = family === 'IPv4' ? ipv4Bytes(address) : ipv6Bytes(address);
  const mask = Buffer.alloc(4 + TRANSACTION_ID_BYTES);
  mask.writeUInt32BE(MAGIC_COOKIE, 0);
  transactionId.copy(mask, 4);
  const value = Buffer.alloc(4 + raw.length);
  value.writeUInt8(FAMILY_CODE[family], 1);
  value.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);
  raw.forEach((byte, i) => value.writeUInt8(byte ^ mask.readUInt8(i), 4 + i));
  return value;
}

function ipv4Bytes(address: string): Buffer {
  if (!isIPv4(address)) throw new RangeError(`not an IPv4 address: ${address}`);
  return Buffer.from(address.split('.').map(Number));
}

/** 16 bytes of an IPv6 literal: `::` compression, an embedded IPv4 tail, a `%zone` (dropped). */
function ipv6Bytes(address: string): Buffer {
  const bare = address.split('%', 1)[0] ?? '';
  if (!isIPv6(bare)) throw new RangeError(`not an IPv6 address: ${address}`);
  const words = (part: string): number[] =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          if (!group.includes('.')) return [parseInt(group, 16)];
          const v4 = ipv4Bytes(group);
          return [v4.readUInt16BE(0), v4.readUInt16BE(2)];
        });
  const [head = '', tail] = bare.split('::');
  const left = words(head);
  const right = tail === undefined ? [] : words(tail);
  const zeros = new Array<number>(8 - left.length - right.length).fill(0);
  const out = Buffer.alloc(16);
  [...left, ...zeros, ...right].forEach((word, i) => out.writeUInt16BE(word, i * 2));
  return out;
}

export interface StunResponderOptions {
  readonly port: number;
  /** Omitted → every local address (dgram's default). */
  readonly host?: string;
  /** Default `udp4`. A `udp6` socket is IPv6-only, so no IPv4-mapped peer is ever reported. */
  readonly type?: 'udp4' | 'udp6';
}

/**
 * One UDP socket answering every valid Binding Request to its sender. Invalid
 * datagrams are dropped silently; a failed send or receive is a lost datagram
 * (STUN clients retransmit), never an agent crash. `start()` once; `close()` is
 * idempotent and releases the port.
 */
export class StunResponder {
  private socket: Socket | null = null;
  private closing: Promise<void> | null = null;
  private answered = 0;

  constructor(private readonly opts: StunResponderOptions) {}

  /** Valid Binding Requests received (each one is answered). */
  get requests(): number {
    return this.answered;
  }

  start(): Promise<{ address: string; port: number }> {
    if (this.socket !== null || this.closing !== null)
      return Promise.reject(new Error('STUN responder already started or closed'));
    // dgram masks an out-of-range port instead of failing, so it is checked here.
    if (!isPort(this.opts.port))
      return Promise.reject(new RangeError(`invalid port ${this.opts.port}`));
    const type = this.opts.type ?? 'udp4';
    const socket = createSocket({ type, ipv6Only: type === 'udp6' });
    this.socket = socket;
    socket.on('message', (msg, peer) => this.answer(socket, msg, peer));
    return new Promise((resolve, reject) => {
      const onBindError = (err: Error): void => {
        this.socket = null;
        socket.close();
        reject(err);
      };
      const onClosedEarly = (): void => reject(new Error('STUN responder closed before binding'));
      socket.once('error', onBindError);
      socket.once('close', onClosedEarly);
      socket.bind(this.opts.port, this.opts.host, () => {
        socket.off('error', onBindError);
        socket.off('close', onClosedEarly);
        socket.on('error', dropDatagram);
        const { address, port } = socket.address();
        resolve({ address, port });
      });
    });
  }

  close(): Promise<void> {
    this.closing ??= new Promise((resolve) => {
      const socket = this.socket;
      this.socket = null;
      if (socket === null) resolve();
      else socket.close(() => resolve());
    });
    return this.closing;
  }

  private answer(socket: Socket, msg: Buffer, peer: RemoteInfo): void {
    const request = parseBindingRequest(msg);
    if (request === null) return;
    this.answered += 1;
    const reply = buildBindingSuccess(request.transactionId, peer.address, peer.port, peer.family);
    socket.send(reply, peer.port, peer.address, dropDatagram);
  }
}

/** A failed send or receive on a bound socket loses one datagram; the client retransmits. */
function dropDatagram(): void {}
