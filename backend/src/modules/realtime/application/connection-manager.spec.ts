import { FakeLink } from '../../../../test/support/realtime-harness';
import type { Connection } from '../domain/connection';
import { ConnectionManager } from './connection-manager';

const AT = new Date('2026-09-01T08:00:00.000Z');

function connection(connectionId: string, userId: string, link = new FakeLink()): Connection {
  return {
    connectionId,
    userId,
    sessionId: `session-${userId}`,
    authenticatedAt: AT,
    expiresAt: new Date(AT.getTime() + 900_000),
    validatedAt: AT,
    lastSeenAt: AT,
    remoteAddress: '203.0.113.9',
    link,
  };
}

describe('ConnectionManager', () => {
  it('registers a connection under its account', () => {
    const manager = new ConnectionManager();
    manager.register(connection('c1', 'u1'));

    expect(manager.get('c1')?.userId).toBe('u1');
    expect(manager.isOnline('u1')).toBe(true);
    expect(manager.isOnline('u2')).toBe(false);
    expect(manager.count()).toBe(1);
  });

  it('holds several devices of one account and sends to each of them', () => {
    const manager = new ConnectionManager();
    const phone = new FakeLink();
    const tablet = new FakeLink();
    const web = new FakeLink();
    manager.register(connection('phone', 'u1', phone));
    manager.register(connection('tablet', 'u1', tablet));
    manager.register(connection('web', 'u1', web));

    expect(manager.getUserConnections('u1').map((c) => c.connectionId)).toEqual([
      'phone',
      'tablet',
      'web',
    ]);
    expect(manager.sendToUser('u1', '{"type":"x","version":1}')).toBe(3);
    for (const link of [phone, tablet, web]) expect(link.frames).toHaveLength(1);
  });

  it('sends to many accounts once each, however often an account is named', () => {
    const manager = new ConnectionManager();
    const a = new FakeLink();
    const b = new FakeLink();
    manager.register(connection('a', 'u1', a));
    manager.register(connection('b', 'u2', b));

    expect(manager.sendToUsers(['u1', 'u2', 'u1', 'nobody'], '{"type":"x","version":1}')).toBe(2);
    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(1);
  });

  it('cleans up on unregister: the account goes offline with its last connection', () => {
    const manager = new ConnectionManager();
    manager.register(connection('c1', 'u1'));
    manager.register(connection('c2', 'u1'));

    manager.unregister('c1');
    expect(manager.isOnline('u1')).toBe(true);
    manager.unregister('c2');
    expect(manager.isOnline('u1')).toBe(false);
    expect(manager.getUserConnections('u1')).toEqual([]);
    expect(manager.count()).toBe(0);
    expect(manager.unregister('c2')).toBeUndefined();
  });

  it('drops a dead connection the moment a send to it fails, and still reaches the live one', () => {
    const manager = new ConnectionManager();
    const dead = new FakeLink();
    const live = new FakeLink();
    manager.register(connection('dead', 'u1', dead));
    manager.register(connection('live', 'u1', live));
    dead.healthy = false;

    expect(manager.sendToUser('u1', '{"type":"x","version":1}')).toBe(1);
    expect(manager.get('dead')).toBeUndefined();
    expect(manager.getUserConnections('u1').map((c) => c.connectionId)).toEqual(['live']);
  });

  it('drops a connection whose transport throws, without failing the send to the others', () => {
    const manager = new ConnectionManager();
    const broken = new FakeLink();
    broken.send = () => {
      throw new Error('socket exploded');
    };
    const live = new FakeLink();
    manager.register(connection('broken', 'u1', broken));
    manager.register(connection('live', 'u2', live));

    expect(manager.sendToUsers(['u1', 'u2'], '{"type":"x","version":1}')).toBe(1);
    expect(manager.isOnline('u1')).toBe(false);
    // Closed, not just forgotten: the client reconnects instead of waiting in silence.
    expect(broken.closed?.code).toBe(1011);
    expect(live.frames).toHaveLength(1);
  });

  it('disconnects: closes with the code given and forgets the connection', () => {
    const manager = new ConnectionManager();
    const link = new FakeLink();
    manager.register(connection('c1', 'u1', link));

    manager.disconnect('c1', 4401, 'unauthorized');

    expect(link.closed).toEqual({ code: 4401, reason: 'unauthorized' });
    expect(manager.isOnline('u1')).toBe(false);
  });
});
