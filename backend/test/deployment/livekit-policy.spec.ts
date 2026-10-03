import { mapping, readYaml } from '../support/deployment-files';

/**
 * LiveKit's server policy, infra/livekit/livekit.yaml (P7.1, decision 9): the
 * same in every environment, with nothing secret and nothing per host in it.
 * The keys themselves were checked against the v1.13.7 source, and the
 * v1.13.7 binary, which parses the file strictly, starts with it; this suite
 * pins the values:
 *
 *   - rooms are never created by a join (`room.auto_create: false` — LiveKit's
 *     default is true) and never unmuted by the server;
 *   - the advertised address is NODE_IP, never one found through STUN;
 *   - the ports are the ones compose publishes;
 *   - production logging, JSON at info;
 *   - nothing else: no keys (LIVEKIT_KEYS only), no development mode, no
 *     webhook, no Redis, no TURN block (TURN is per environment).
 */

const policy = mapping(readYaml('infra/livekit/livekit.yaml'), 'livekit.yaml');

describe('the LiveKit server policy', () => {
  it('never creates a room on a join, and never unmutes anyone from the server', () => {
    expect(policy.room).toStrictEqual({ auto_create: false, enable_remote_unmute: false });
  });

  it('advertises NODE_IP, never an address found through STUN', () => {
    const rtc = mapping(policy.rtc, 'rtc');
    expect(rtc.use_external_ip).toBe(false);
    // No address in the file: each host gives its own, through NODE_IP.
    expect(rtc.node_ip).toBeUndefined();
  });

  it('binds signalling to loopback and the private bridge gateway only, never a public IP', () => {
    // P7.3 / decision B: LiveKit runs host-networked, so the signalling server
    // must not listen on every interface. Both are deployment constants (nginx
    // reaches 127.0.0.1; the bridged API reaches the gateway), neither public.
    expect(policy.bind_addresses).toEqual(['127.0.0.1', '172.30.0.1']);
  });

  it('listens for signalling on 7880, ICE over TCP on 7881 and ICE over UDP on one muxed 7882', () => {
    expect(policy.port).toBe(7880);
    const rtc = mapping(policy.rtc, 'rtc');
    expect({ tcp: rtc.tcp_port, udp: rtc.udp_port }).toEqual({ tcp: 7881, udp: 7882 });
    // A port range would take precedence over the mux and open 10,000 ports.
    expect(rtc.port_range_start).toBeUndefined();
    expect(rtc.port_range_end).toBeUndefined();
  });

  it('logs JSON lines at info', () => {
    expect(policy.logging).toStrictEqual({ level: 'info', json: true });
  });

  it('holds only the policy: no key, no development mode, no webhook, no Redis, no TURN', () => {
    // bind_addresses is topology (loopback + bridge gateway), not a secret and
    // not per-host; TURN is still absent (per environment, via the override).
    expect(Object.keys(policy).sort()).toEqual([
      'bind_addresses',
      'logging',
      'port',
      'room',
      'rtc',
    ]);
    expect(Object.keys(mapping(policy.rtc, 'rtc')).sort()).toEqual([
      'tcp_port',
      'udp_port',
      'use_external_ip',
    ]);
  });
});
