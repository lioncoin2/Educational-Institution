import { createSocket, type Socket } from 'node:dgram';
import { buildBindingSuccess, parseBindingRequest, StunResponder } from '../fleet/stun';

const LOOPBACK = '127.0.0.1';
const COOKIE = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
/** RFC 5769 §2 sample transaction id. */
const TXID = Buffer.from('b7e7a701bc34d686fa87dfae', 'hex');
/**
 * RFC 5769 §2.1 — a real ICE Binding Request (SOFTWARE, PRIORITY, ICE-CONTROLLED,
 * USERNAME, MESSAGE-INTEGRITY, FINGERPRINT); attributes must be ignored, not rejected.
 */
const RFC5769_REQUEST = Buffer.from(
  '000100582112a442b7e7a701bc34d686fa87dfae802200105354554e207465737420636c69656e74' +
    '002400046e0001ff80290008932ff9b151263b36000600096576746a3a68367659202020' +
    '000800149aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a280280004e57a3bcf',
  'hex',
);

function request(txid: Buffer, attributes = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0001, 0);
  header.writeUInt16BE(attributes.length, 2);
  COOKIE.copy(header, 4);
  txid.copy(header, 8);
  return Buffer.concat([header, attributes]);
}

interface Decoded {
  readonly type: number;
  readonly txid: Buffer;
  readonly attributes: ReadonlyMap<number, Buffer>;
  readonly mapped: { family: 'IPv4' | 'IPv6'; address: string; port: number };
}

/** Independent response decoder (RFC 5389 §6, §15, §15.2); IPv6 is printed uncompressed. */
function decode(msg: Buffer): Decoded {
  expect(msg.subarray(4, 8)).toEqual(COOKIE);
  expect(msg.readUInt16BE(2)).toBe(msg.length - 20);
  expect(msg.readUInt16BE(2) % 4).toBe(0);
  const attributes = new Map<number, Buffer>();
  for (let at = 20; at < msg.length;) {
    const length = msg.readUInt16BE(at + 2);
    attributes.set(msg.readUInt16BE(at), msg.subarray(at + 4, at + 4 + length));
    at += 4 + Math.ceil(length / 4) * 4;
  }
  const xma = attributes.get(0x0020)!;
  const mask = Buffer.concat([COOKIE, msg.subarray(8, 20)]);
  const raw = [...xma.subarray(4)].map((byte, i) => byte ^ mask[i]);
  const ipv4 = xma[1] === 0x01;
  const address = ipv4
    ? raw.join('.')
    : [0, 2, 4, 6, 8, 10, 12, 14].map((i) => ((raw[i] << 8) | raw[i + 1]).toString(16)).join(':');
  return {
    type: msg.readUInt16BE(0),
    txid: msg.subarray(8, 20),
    attributes,
    mapped: { family: ipv4 ? 'IPv4' : 'IPv6', address, port: xma.readUInt16BE(2) ^ 0x2112 },
  };
}

describe('STUN codec — parseBindingRequest', () => {
  it('accepts a Binding Request with or without attributes and copies the transaction id', () => {
    expect(parseBindingRequest(request(TXID))).toEqual({ transactionId: TXID });
    const wire = Buffer.from(RFC5769_REQUEST);
    const parsed = parseBindingRequest(wire);
    wire.fill(0);
    expect(parsed).toEqual({ transactionId: TXID });
  });

  it('returns null for anything else and never throws', () => {
    const wrongCookie = request(TXID);
    wrongCookie.writeUInt32BE(0x2112a443, 4);
    const response = request(TXID);
    response.writeUInt16BE(0x0101, 0);
    const indication = request(TXID);
    indication.writeUInt16BE(0x0011, 0);
    const longer = Buffer.concat([request(TXID), Buffer.alloc(4)]);
    const unaligned = request(TXID, Buffer.alloc(3));
    for (const bad of [
      Buffer.alloc(0),
      request(TXID).subarray(0, 19),
      Buffer.alloc(20),
      wrongCookie,
      response,
      indication,
      longer,
      unaligned,
      RFC5769_REQUEST.subarray(0, 100),
      Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'),
    ])
      expect(parseBindingRequest(bad)).toBeNull();
  });
});

describe('STUN codec — buildBindingSuccess', () => {
  it('encodes XOR-MAPPED-ADDRESS byte-exactly as the RFC 5769 §2.2/§2.3 samples', () => {
    const v4 = decode(buildBindingSuccess(TXID, '192.0.2.1', 32853, 'IPv4'));
    expect(v4.attributes.get(0x0020)?.toString('hex')).toBe('0001a147e112a643');
    const v6 = decode(
      buildBindingSuccess(TXID, '2001:db8:1234:5678:11:2233:4455:6677', 32853, 'IPv6'),
    );
    expect(v6.attributes.get(0x0020)?.toString('hex')).toBe(
      '0002a1470113a9faa5d3f179bc25f4b5bed2b9d9',
    );
  });

  it('builds a success response: type, transaction id, length and SOFTWARE', () => {
    const msg = buildBindingSuccess(TXID, '203.0.113.7', 3479, 'IPv4');
    const decoded = decode(msg);
    expect(decoded.type).toBe(0x0101);
    expect(decoded.txid).toEqual(TXID);
    expect([...decoded.attributes.keys()]).toEqual([0x0020, 0x8022]);
    expect(decoded.attributes.get(0x8022)?.toString('utf8')).toBe('p84-stun');
    expect(msg.length).toBe(20 + 12 + 12);
    expect(buildBindingSuccess(TXID, '::1', 1, 'IPv6').length).toBe(20 + 24 + 12);
  });

  it.each([
    ['IPv4', '127.0.0.1', 0, '127.0.0.1'],
    ['IPv4', '255.255.255.255', 65535, '255.255.255.255'],
    ['IPv6', '::1', 3479, '0:0:0:0:0:0:0:1'],
    ['IPv6', '2001:db8::', 50000, '2001:db8:0:0:0:0:0:0'],
    ['IPv6', 'fe80::a:b%eth0', 7, 'fe80:0:0:0:0:0:a:b'],
    ['IPv6', '::ffff:192.0.2.1', 32853, '0:0:0:0:0:ffff:c000:201'],
    ['IPv6', '2001:DB8:0:1:2:3:4:5', 1, '2001:db8:0:1:2:3:4:5'],
  ] as const)('round-trips %s %s port %d', (family, address, port, expected) => {
    const txid = Buffer.from('0123456789abcdef01234567', 'hex');
    expect(decode(buildBindingSuccess(txid, address, port, family)).mapped).toEqual({
      family,
      address: expected,
      port,
    });
  });

  it('rejects a malformed transaction id, port or address', () => {
    expect(() => buildBindingSuccess(TXID.subarray(0, 11), '127.0.0.1', 1, 'IPv4')).toThrow(
      RangeError,
    );
    for (const port of [-1, 65536, 1.5, Number.NaN])
      expect(() => buildBindingSuccess(TXID, '127.0.0.1', port, 'IPv4')).toThrow(RangeError);
    expect(() => buildBindingSuccess(TXID, '::1', 1, 'IPv4')).toThrow(RangeError);
    expect(() => buildBindingSuccess(TXID, '127.0.0.1', 1, 'IPv6')).toThrow(RangeError);
    expect(() => buildBindingSuccess(TXID, '1:2:3', 1, 'IPv6')).toThrow(RangeError);
  });
});

describe('StunResponder (127.0.0.1)', () => {
  const open: Array<StunResponder | Socket> = [];

  afterEach(async () => {
    await Promise.all(
      open
        .splice(0)
        .map((s) =>
          s instanceof StunResponder ? s.close() : new Promise<void>((done) => s.close(done)),
        ),
    );
  });

  async function responder(port = 0): Promise<{ stun: StunResponder; port: number }> {
    const stun = new StunResponder({ port, host: LOOPBACK, type: 'udp4' });
    open.push(stun);
    const bound = await stun.start();
    expect(bound.address).toBe(LOOPBACK);
    return { stun, port: bound.port };
  }

  async function udpSocket(port = 0): Promise<Socket> {
    const socket = createSocket('udp4');
    open.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, LOOPBACK, () => resolve());
    });
    return socket;
  }

  function send(socket: Socket, msg: Buffer, port: number): Promise<void> {
    return new Promise((resolve, reject) =>
      socket.send(msg, port, LOOPBACK, (err) => (err ? reject(err) : resolve())),
    );
  }

  function collect(socket: Socket, ms: number): Promise<Buffer[]> {
    const got: Buffer[] = [];
    const onMessage = (msg: Buffer): void => void got.push(msg);
    socket.on('message', onMessage);
    return new Promise((resolve) =>
      setTimeout(() => {
        socket.off('message', onMessage);
        resolve(got);
      }, ms),
    );
  }

  function nextMessage(socket: Socket): Promise<Buffer> {
    return new Promise((resolve) => socket.once('message', resolve));
  }

  it("answers a Binding Request with the client's address and port", async () => {
    const { stun, port } = await responder();
    const client = await udpSocket();
    const reply = nextMessage(client);
    await send(client, request(TXID), port);
    const decoded = decode(await reply);
    expect(decoded.type).toBe(0x0101);
    expect(decoded.txid).toEqual(TXID);
    expect(decoded.mapped).toEqual({
      family: 'IPv4',
      address: LOOPBACK,
      port: client.address().port,
    });
    expect(stun.requests).toBe(1);

    const iceReply = nextMessage(client);
    await send(client, RFC5769_REQUEST, port);
    expect(decode(await iceReply).txid).toEqual(TXID);
    expect(stun.requests).toBe(2);
  });

  it('ignores garbage, short and wrong-cookie packets, then still answers', async () => {
    const { stun, port } = await responder();
    const client = await udpSocket();
    const wrongCookie = request(TXID);
    wrongCookie.writeUInt32BE(0xdeadbeef, 4);
    const replies = collect(client, 200);
    for (const bad of [Buffer.from('garbage'), request(TXID).subarray(0, 19), wrongCookie])
      await send(client, bad, port);
    expect(await replies).toEqual([]);
    expect(stun.requests).toBe(0);

    const txid = Buffer.from('000000000000000000000001', 'hex');
    const reply = nextMessage(client);
    await send(client, request(txid), port);
    expect(decode(await reply).txid).toEqual(txid);
    expect(stun.requests).toBe(1);
  });

  it('close() is idempotent, releases the port and ends the responder', async () => {
    const { stun, port } = await responder();
    const first = stun.close();
    expect(stun.close()).toBe(first);
    await first;
    await stun.close();
    await expect(udpSocket(port)).resolves.toBeDefined();
    await expect(stun.start()).rejects.toThrow('already started or closed');
    await expect(new StunResponder({ port: 0 }).close()).resolves.toBeUndefined();
  });

  it('close() during a pending start() settles both', async () => {
    const stun = new StunResponder({ port: 0, host: LOOPBACK });
    const started = stun.start();
    await stun.close();
    await expect(started).rejects.toThrow('closed before binding');
  });

  it('start() rejects on a bind error or an invalid port, leaving nothing open', async () => {
    const holder = await udpSocket();
    const taken = new StunResponder({ port: holder.address().port, host: LOOPBACK });
    await expect(taken.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await taken.close();
    await expect(new StunResponder({ port: 70000, host: LOOPBACK }).start()).rejects.toThrow(
      RangeError,
    );
  });
});
