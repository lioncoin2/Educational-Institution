import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  PINNED_LIVEKIT_SERVER_VERSION,
  apiUrlFault,
} from '../../src/platform/config/livekit-config';
import {
  COMPOSE_FILE,
  REPO_ROOT,
  TURN_OVERRIDE_FILE,
  containerEnvironment,
  environmentOf,
  interpolate,
  interpolatedVariables,
  mapping,
  readRepoFile,
  readYaml,
  servicesOf,
  texts,
  type Mapping,
} from '../support/deployment-files';

/**
 * The Docker topology (P7.1, decision 9), read from the committed compose
 * files. The properties, each asserted on its own:
 *
 *   - two services, the API (built from backend/Dockerfile) and LiveKit (the
 *     pinned image, by tag and digest), each its own container; the TURN
 *     override touches LiveKit's variables and ports and nothing else;
 *   - no container holds a privilege: not privileged, no Docker socket, no
 *     host namespace, every capability dropped, no privilege escalation;
 *   - the published ports are exactly the documented ones — LiveKit's
 *     signalling port on loopback only, the TURN ports only in the override;
 *   - explicit health checks, `restart: unless-stopped`, and an ordering-only
 *     dependency of the API on LiveKit;
 *   - LiveKit receives an allow-list of variables — its keys, built from the
 *     API's own pair, its node IP and TURN — never an API secret or a
 *     LIVEKIT_<PATH> override of its policy file;
 *   - the API receives exactly the settings its configuration reads, and
 *     reaches LiveKit over the private network.
 */

/** Decision 1: the image of the pinned release, by digest. */
const LIVEKIT_IMAGE = `livekit/livekit-server:v${PINNED_LIVEKIT_SERVER_VERSION}@sha256:6fd3b7088874c4d119160dd688798dfec852bc014786d392caad15f6f63912a3`;

const TURN_VARIABLES = [
  'LIVEKIT_TURN_DOMAIN',
  'LIVEKIT_TURN_ENABLED',
  'LIVEKIT_TURN_EXTERNAL_TLS',
  'LIVEKIT_TURN_TLS_PORT',
  'LIVEKIT_TURN_UDP_PORT',
];

const base = readYaml(COMPOSE_FILE);
const override = readYaml(TURN_OVERRIDE_FILE);
const services = servicesOf(base, COMPOSE_FILE);
const overrideServices = servicesOf(override, TURN_OVERRIDE_FILE);
const api = services.api ?? {};
const livekit = services.livekit ?? {};
const turn = overrideServices.livekit ?? {};
const livekitPolicy = mapping(readYaml('infra/livekit/livekit.yaml'), 'livekit.yaml');

/** A published port, short syntax, its protocol always stated. */
const PORT = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d+):(\d+)\/(tcp|udp)$/;

function portsOf(service: Mapping, where: string) {
  return texts(service.ports, `${where}.ports`).map((entry) => {
    const match = PORT.exec(entry);
    if (match === null) throw new Error(`${where}.ports: ${entry} is not host[:ip]:port/protocol`);
    return {
      hostIp: match[1] ?? null,
      published: Number(match[2]),
      target: Number(match[3]),
      protocol: match[4],
    };
  });
}

/** Every API setting its configuration reads: `env.X`, `required('X')`, `secret('X')`. */
function settingsTheApiReads(): string[] {
  const directory = join(REPO_ROOT, 'backend', 'src', 'platform', 'config');
  const names = new Set<string>();
  for (const file of readdirSync(directory)) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
    const source = readRepoFile(`backend/src/platform/config/${file}`);
    for (const match of source.matchAll(
      /\benv\.([A-Z][A-Z0-9_]*)|\b(?:required|secret)\('([A-Z][A-Z0-9_]*)'/g,
    )) {
      names.add(match[1] ?? match[2] ?? '');
    }
  }
  return [...names].sort();
}

describe('the compose topology', () => {
  it('runs exactly two services, the API and LiveKit, each in its own container', () => {
    expect(Object.keys(services).sort()).toEqual(['api', 'livekit']);
    expect(api.build).toEqual({ context: '../backend', dockerfile: 'Dockerfile' });
    expect(api.image).toBeUndefined();
    expect(livekit.build).toBeUndefined();
    // The override adds TURN to LiveKit and changes nothing else.
    expect(Object.keys(overrideServices)).toEqual(['livekit']);
    expect(Object.keys(turn).sort()).toEqual(['environment', 'ports']);
  });

  it('runs LiveKit from the pinned release, by tag and digest', () => {
    expect(livekit.image).toBe(LIVEKIT_IMAGE);
  });

  it('gives LiveKit the committed policy file, read-only, and nothing else to read', () => {
    expect(livekit.command).toEqual(['--config', '/etc/livekit/livekit.yaml']);
    expect(livekit.volumes).toEqual(['./livekit/livekit.yaml:/etc/livekit/livekit.yaml:ro']);
    expect(livekit.env_file).toBeUndefined();
  });

  it('grants neither container a privilege: not privileged, no Docker socket, no host namespace', () => {
    for (const [name, service] of Object.entries(services)) {
      for (const key of [
        'privileged',
        'network_mode',
        'pid',
        'ipc',
        'uts',
        'userns_mode',
        'cgroup',
        'cap_add',
        'devices',
        'env_file',
      ]) {
        expect({ service: name, key, value: service[key] }).toEqual({
          service: name,
          key,
          value: undefined,
        });
      }
      expect({ service: name, cap_drop: service.cap_drop }).toEqual({
        service: name,
        cap_drop: ['ALL'],
      });
      expect({ service: name, security_opt: service.security_opt }).toEqual({
        service: name,
        security_opt: ['no-new-privileges:true'],
      });
      // Only named volumes and files under infra/ are mounted: never a host
      // path, and so never the Docker socket.
      for (const volume of texts(service.volumes, `services.${name}.volumes`)) {
        expect(volume).not.toMatch(/^\/|docker\.sock/);
      }
    }
  });

  it('keeps the API’s stored files on a named volume', () => {
    expect(api.volumes).toEqual(['api-storage:/app/.storage']);
    expect(environmentOf(api, 'services.api').STORAGE_LOCAL_ROOT).toBe('/app/.storage');
    expect(Object.keys(mapping(mapping(base, COMPOSE_FILE).volumes, 'volumes'))).toEqual([
      'api-storage',
    ]);
  });

  it('publishes exactly the documented ports, the signalling port on loopback only', () => {
    expect(texts(livekit.ports, 'services.livekit.ports')).toEqual([
      '127.0.0.1:7880:7880/tcp',
      '7881:7881/tcp',
      '7882:7882/udp',
    ]);
    expect(texts(api.ports, 'services.api.ports')).toEqual(['127.0.0.1:3000:3000/tcp']);

    // Each port is published where the process listens: LiveKit's policy file,
    // the API's PORT.
    const livekitPorts = portsOf(livekit, 'services.livekit');
    const rtc = mapping(livekitPolicy.rtc, 'rtc');
    expect(livekitPorts.map(({ target, protocol }) => `${target}/${protocol}`)).toEqual([
      `${String(livekitPolicy.port)}/tcp`,
      `${String(rtc.tcp_port)}/tcp`,
      `${String(rtc.udp_port)}/udp`,
    ]);
    expect(portsOf(api, 'services.api')[0]?.target).toBe(
      Number(environmentOf(api, 'services.api').PORT),
    );
  });

  it('publishes the TURN ports only through the TURN override, where TURN listens', () => {
    expect(texts(turn.ports, 'override: services.livekit.ports')).toEqual([
      '3478:3478/udp',
      '127.0.0.1:5349:5349/tcp',
    ]);
    const published = [...portsOf(livekit, 'services.livekit'), ...portsOf(api, 'services.api')];
    expect(published.filter(({ target }) => target === 3478 || target === 5349)).toEqual([]);
    expect(
      Object.keys(environmentOf(livekit, 'services.livekit')).filter((name) =>
        name.startsWith('LIVEKIT_TURN_'),
      ),
    ).toEqual([]);

    const turnEnvironment = environmentOf(turn, 'override: services.livekit');
    expect(turnEnvironment).toEqual({
      LIVEKIT_TURN_ENABLED: 'true',
      LIVEKIT_TURN_DOMAIN: expect.stringMatching(/^\$\{LIVEKIT_TURN_DOMAIN:\?[^}]*\}$/) as string,
      LIVEKIT_TURN_UDP_PORT: '3478',
      LIVEKIT_TURN_TLS_PORT: '5349',
      LIVEKIT_TURN_EXTERNAL_TLS: 'true',
    });
    // TURN/UDP is public; TURN/TLS reaches LiveKit only through the TLS terminator.
    expect(portsOf(turn, 'override: services.livekit')).toEqual([
      {
        hostIp: null,
        published: Number(turnEnvironment.LIVEKIT_TURN_UDP_PORT),
        target: Number(turnEnvironment.LIVEKIT_TURN_UDP_PORT),
        protocol: 'udp',
      },
      {
        hostIp: '127.0.0.1',
        published: Number(turnEnvironment.LIVEKIT_TURN_TLS_PORT),
        target: Number(turnEnvironment.LIVEKIT_TURN_TLS_PORT),
        protocol: 'tcp',
      },
    ]);
  });

  it('checks each container’s health explicitly, on the port it listens on', () => {
    for (const [name, service] of Object.entries(services)) {
      const healthcheck = mapping(service.healthcheck, `services.${name}.healthcheck`);
      expect(Object.keys(healthcheck).sort()).toEqual([
        'interval',
        'retries',
        'start_period',
        'test',
        'timeout',
      ]);
    }
    // LiveKit's own health endpoint, answered "OK" when ready — busybox wget
    // and grep ship in the image.
    expect(mapping(livekit.healthcheck, 'livekit.healthcheck').test).toEqual([
      'CMD-SHELL',
      `wget -q -O - http://127.0.0.1:${String(livekitPolicy.port)}/ | grep -qx OK`,
    ]);
    // The API's readiness route, with the image's own node.
    const apiTest = texts(mapping(api.healthcheck, 'api.healthcheck').test, 'api.healthcheck.test');
    expect(apiTest.slice(0, 3)).toEqual(['CMD', 'node', '-e']);
    expect(apiTest[3]).toContain(
      `fetch('http://127.0.0.1:${environmentOf(api, 'services.api').PORT}/health/ready')`,
    );
  });

  it('restarts both unless stopped — LiveKit exits 0 even when it cannot start', () => {
    expect(api.restart).toBe('unless-stopped');
    expect(livekit.restart).toBe('unless-stopped');
  });

  it('starts the API after LiveKit without waiting for LiveKit to be ready', () => {
    expect(api.depends_on).toEqual({ livekit: { condition: 'service_started' } });
    expect(livekit.depends_on).toBeUndefined();
  });

  it('hands LiveKit an allow-list of variables: its keys, its node IP and TURN, nothing of the API’s', () => {
    const own = environmentOf(livekit, 'services.livekit');
    const withTurn = { ...own, ...environmentOf(turn, 'override: services.livekit') };
    expect(Object.keys(own).sort()).toEqual(['LIVEKIT_KEYS', 'NODE_IP']);
    expect(Object.keys(withTurn).sort()).toEqual(
      ['LIVEKIT_KEYS', 'NODE_IP', ...TURN_VARIABLES].sort(),
    );
    // Each value comes from LiveKit's own entries in the environment file…
    expect([...interpolatedVariables(Object.values(withTurn))].sort()).toEqual([
      ['LIVEKIT_API_KEY', true],
      ['LIVEKIT_API_SECRET', true],
      ['LIVEKIT_NODE_IP', true],
      ['LIVEKIT_TURN_DOMAIN', true],
    ]);
    // …and nothing that would override its policy file, or that is the API's.
    for (const forbidden of [
      'LIVEKIT_ROOM_AUTO_CREATE',
      'LIVEKIT_CONFIG',
      'LIVEKIT_DEVELOPMENT',
      'LIVEKIT_KEY_FILE',
      'REDIS_HOST',
      'JWT_SECRET',
      'STORAGE_SIGNING_SECRET',
      'DATABASE_URL',
    ]) {
      expect(Object.keys(withTurn)).not.toContain(forbidden);
    }
    expect(turn.env_file).toBeUndefined();
  });

  it('builds LIVEKIT_KEYS from the very key and secret the API signs with', () => {
    const pair = new Map([
      ['LIVEKIT_API_KEY', 'APIexample'],
      ['LIVEKIT_API_SECRET', 'secret-of-the-environment'],
      ['LIVEKIT_NODE_IP', '192.0.2.1'],
    ]);
    const received = containerEnvironment(environmentOf(livekit, 'services.livekit'), pair);
    // "key: secret", the space included — the only form LiveKit accepts.
    expect(received.LIVEKIT_KEYS).toBe('APIexample: secret-of-the-environment');
    const apiEnvironment = environmentOf(api, 'services.api');
    expect(interpolate(apiEnvironment.LIVEKIT_API_KEY ?? '', pair)).toBe('APIexample');
    expect(interpolate(apiEnvironment.LIVEKIT_API_SECRET ?? '', pair)).toBe(
      'secret-of-the-environment',
    );
    // Without a secret, compose refuses to start either container.
    pair.delete('LIVEKIT_API_SECRET');
    expect(() => containerEnvironment(environmentOf(livekit, 'services.livekit'), pair)).toThrow(
      'required variable LIVEKIT_API_SECRET is missing a value',
    );
    expect(() => interpolate(apiEnvironment.LIVEKIT_API_SECRET ?? '', pair)).toThrow(
      'required variable LIVEKIT_API_SECRET is missing a value',
    );
  });

  it('reaches LiveKit over the private network, which a deployed API accepts', () => {
    const apiUrl = environmentOf(api, 'services.api').LIVEKIT_API_URL ?? '';
    expect(apiUrl).toBe(`http://livekit:${String(livekitPolicy.port)}`);
    // `livekit` is the service's name on the project network: an internal
    // host, so plain HTTP passes the staging and production check.
    expect(apiUrlFault(apiUrl, true)).toBeNull();
    expect(Object.keys(services)).toContain(new URL(apiUrl).hostname);
  });

  it('passes the API every setting its configuration reads, and nothing else', () => {
    const settings = settingsTheApiReads();
    // Not vacuous: the scan finds the configuration's settings.
    expect(settings).toEqual(expect.arrayContaining(['NODE_ENV', 'JWT_SECRET', 'LIVEKIT_URL']));
    expect(Object.keys(environmentOf(api, 'services.api')).sort()).toEqual(settings);
  });
});
