import { clientAddress } from './client-address';

describe('the client address used for handshake limits', () => {
  it('is the socket peer when no proxy is trusted — whatever X-Forwarded-For claims', () => {
    expect(clientAddress('10.0.0.5', '198.51.100.1', false)).toBe('10.0.0.5');
    expect(clientAddress('10.0.0.5', '198.51.100.1', 0)).toBe('10.0.0.5');
  });

  it('is the left-most forwarded address when every proxy is trusted', () => {
    expect(clientAddress('10.0.0.5', '198.51.100.1, 10.0.0.9', true)).toBe('198.51.100.1');
  });

  it('counts trusted hops from the socket, as Express does', () => {
    // client 198.51.100.1 → proxy A (appends 198.51.100.1) → proxy B (appends A=10.0.0.9) → us
    const header = '203.0.113.66, 198.51.100.1, 10.0.0.9';
    expect(clientAddress('10.0.0.5', header, 1)).toBe('10.0.0.9');
    expect(clientAddress('10.0.0.5', header, 2)).toBe('198.51.100.1');
    // A forged left-most entry is never reached with the right hop count.
    expect(clientAddress('10.0.0.5', header, 2)).not.toBe('203.0.113.66');
  });

  it('never walks past the chain, and survives a missing header or peer', () => {
    expect(clientAddress('10.0.0.5', undefined, 3)).toBe('10.0.0.5');
    expect(clientAddress('10.0.0.5', ['198.51.100.1', '10.0.0.9'], 5)).toBe('198.51.100.1');
    expect(clientAddress(undefined, undefined, false)).toBe('unknown');
  });
});
