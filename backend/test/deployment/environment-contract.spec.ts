import { randomBytes } from 'node:crypto';

import { CORE_SCHEMA, load } from 'js-yaml';

import { ConfigurationError, loadConfig } from '../../src/platform/config/app-config';
import {
  PINNED_LIVEKIT_SERVER_VERSION,
  clientUrlFault,
} from '../../src/platform/config/livekit-config';
import {
  COMPOSE_FILE,
  DATA_FILE,
  DEPLOYED_ENVIRONMENTS,
  ENVIRONMENTS,
  TURN_OVERRIDE_FILE,
  containerEnvironment,
  environmentOf,
  exampleFile,
  interpolatedVariables,
  readEnvFile,
  readRepoFile,
  readYaml,
  servicesOf,
  text,
  type Environment,
} from '../support/deployment-files';

/**
 * The environment contract (P7.1, decisions 2–4 and 9): one example file per
 * environment, infra/env/<env>.env.example, feeding the compose files'
 * interpolation. The properties, each asserted on its own:
 *
 *   - each file sets every variable its compose files require, and nothing
 *     they do not read — staging and production also TURN's hostname;
 *   - the LiveKit contract everywhere: real media on, the pinned version
 *     (the image's), a client URL, key, secret and node IP;
 *   - no secret at all: every secret ships EMPTY, hosts under reserved
 *     `example` names, documentation addresses — nothing real-looking;
 *   - as shipped, nothing can start: every secret is empty and required by
 *     the compose files, so compose refuses to start any container — LiveKit
 *     included, which would otherwise run on a known secret — and the API
 *     would refuse to boot too; with generated secrets, it boots the API —
 *     the contract is complete — and LiveKit receives the same key and
 *     secret in the form it parses;
 *   - staging and production demand wss://, and refuse ws://;
 *   - each environment its own LiveKit hosts and room prefix, and real
 *     environment files never committed.
 */

const base = readYaml(COMPOSE_FILE);
const override = readYaml(TURN_OVERRIDE_FILE);
const data = readYaml(DATA_FILE);
const services = servicesOf(base, COMPOSE_FILE);
const apiEnvironment = environmentOf(services.api ?? {}, 'services.api');
const livekitEnvironment = environmentOf(services.livekit ?? {}, 'services.livekit');

const examples = new Map(
  ENVIRONMENTS.map((environment) => [environment, readEnvFile(exampleFile(environment))]),
);

function exampleOf(environment: Environment): Map<string, string> {
  const variables = examples.get(environment);
  if (variables === undefined) throw new Error(`no example for ${environment}`);
  return variables;
}

const deployed = (environment: Environment) => DEPLOYED_ENVIRONMENTS.includes(environment);

/** Every variable the compose files of an environment read, and those they require. */
function variablesRead(environment: Environment): { read: Set<string>; required: string[] } {
  // Deployed environments layer on the TURN override and the data tier (D3).
  const documents = deployed(environment) ? [base, override, data] : [base];
  const interpolated = interpolatedVariables(documents);
  const passedThrough = Object.keys(apiEnvironment).filter((name) => apiEnvironment[name] === null);
  return {
    read: new Set([...interpolated.keys(), ...passedThrough]),
    required: [...interpolated].filter(([, required]) => required).map(([name]) => name),
  };
}

const SECRETS = ['JWT_SECRET', 'STORAGE_SIGNING_SECRET', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
/** P7.3 / D3: the data-tier passwords — secrets too, required only where the data tier runs. */
const DATA_SECRETS = ['POSTGRES_PASSWORD', 'REDIS_PASSWORD'];
/** Every secret that must ship empty in an environment's example. */
const secretsOf = (environment: Environment) =>
  deployed(environment) ? [...SECRETS, ...DATA_SECRETS] : SECRETS;
const LIVEKIT_CONTRACT = [
  'LIVE_MEDIA_PROVIDER',
  'LIVE_ROOM_NAME_PREFIX',
  'LIVEKIT_URL',
  'LIVEKIT_VERSION',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_NODE_IP',
];

/** A secret as each file's header says to make one. */
const generatedSecret = () => randomBytes(48).toString('base64url');

/** The example with its placeholders replaced, as its header instructs. */
function completed(environment: Environment): Map<string, string> {
  const variables = new Map(exampleOf(environment));
  variables.set('JWT_SECRET', generatedSecret());
  variables.set('STORAGE_SIGNING_SECRET', generatedSecret());
  variables.set('LIVEKIT_API_KEY', `API${randomBytes(6).toString('hex')}`);
  variables.set('LIVEKIT_API_SECRET', generatedSecret());
  return variables;
}

/** Why the API, given what compose hands its container, refuses to boot; empty when it boots. */
function refusals(variables: ReadonlyMap<string, string>): string[] {
  try {
    loadConfig(containerEnvironment(apiEnvironment, variables));
    return [];
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return error.message
      .split('\n')
      .slice(1)
      .map((line) => line.replace(/^\s*- /, ''));
  }
}

/** Compose's refusal to render a container's environment from `variables`, or 'rendered'. */
function rendering(
  environment_: Parameters<typeof containerEnvironment>[0],
  variables: ReadonlyMap<string, string>,
): string {
  try {
    containerEnvironment(environment_, variables);
    return 'rendered';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** RFC 5737's documentation ranges: an address that belongs to no one. */
const DOCUMENTATION_ADDRESS = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;

describe.each(ENVIRONMENTS)('the %s environment file', (environment) => {
  const variables = exampleOf(environment);

  it('names its environment', () => {
    expect(variables.get('NODE_ENV')).toBe(environment);
  });

  it('sets every variable its compose files require, and only variables they read — the secrets left empty', () => {
    const { read, required } = variablesRead(environment);
    const secrets = secretsOf(environment);
    for (const name of required) {
      expect({ name, value: variables.get(name) }).toEqual({
        name,
        // A secret is named but empty (see "as shipped" below); every other
        // required variable has its value.
        value: secrets.includes(name) ? '' : (expect.stringMatching(/./) as string),
      });
    }
    expect([...variables.keys()].filter((name) => !read.has(name))).toEqual([]);
  });

  it('carries the LiveKit contract: real media on the pinned server', () => {
    for (const name of LIVEKIT_CONTRACT) {
      expect({ name, value: variables.get(name) }).toEqual({
        name,
        // The key and the secret are named, and empty until a deployment sets them.
        value: SECRETS.includes(name) ? '' : (expect.stringMatching(/./) as string),
      });
    }
    expect(variables.get('LIVE_MEDIA_PROVIDER')).toBe('livekit');
    expect(variables.get('LIVEKIT_VERSION')).toBe(PINNED_LIVEKIT_SERVER_VERSION);
    // …the version of the image compose runs.
    expect(text(services.livekit?.image, 'services.livekit.image')).toContain(
      `:v${variables.get('LIVEKIT_VERSION')}@sha256:`,
    );
    // TURN is for the deployed environments only.
    expect(variables.has('LIVEKIT_TURN_DOMAIN')).toBe(deployed(environment));
  });

  it('holds no secret: every secret empty, and no real-looking host or address', () => {
    for (const name of secretsOf(environment)) {
      expect({ name, value: variables.get(name) }).toEqual({ name, value: '' });
    }
    // The data stores carry only the placeholder password, under their private
    // service names (D3) — not a real host, and not a secret.
    for (const name of ['DATABASE_URL', 'REDIS_URL']) {
      const url = variables.get(name) ?? '';
      if (url === '') continue;
      expect(new URL(url).password).toBe('change-me');
      expect(new URL(url).hostname).toBe(name === 'DATABASE_URL' ? 'db' : 'redis');
    }
    // The gateway the API uses for LiveKit control is the pinned private subnet's .1.
    const apiUrl = variables.get('LIVEKIT_API_URL');
    if (apiUrl !== undefined) expect(new URL(apiUrl).hostname).toBe('172.30.0.1');

    // The public-facing hosts/addresses must still be reserved documentation names.
    const hosts = [
      new URL(variables.get('LIVEKIT_URL') ?? '').hostname,
      ...(deployed(environment) ? [variables.get('LIVEKIT_TURN_DOMAIN') ?? ''] : []),
    ];
    const nodeIp = variables.get('LIVEKIT_NODE_IP') ?? '';
    if (deployed(environment)) {
      for (const host of hosts) expect(host).toMatch(/(^|\.)example(\.|$)/);
      expect(nodeIp).toMatch(DOCUMENTATION_ADDRESS);
    } else {
      expect(hosts).toEqual(['localhost']);
      expect(nodeIp).toBe('127.0.0.1');
    }

    // Nothing that looks generated: a JWT, a PEM block, a long run of the
    // base64url or hex alphabet mixing letters and digits.
    for (const [name, value] of variables) {
      expect({ name, jwt: value.includes('eyJ'), pem: value.includes('-----BEGIN') }).toEqual({
        name,
        jwt: false,
        pem: false,
      });
      const generated = (value.match(/[A-Za-z0-9_-]{16,}/g) ?? []).filter(
        (run) => /[A-Za-z]/.test(run) && /\d/.test(run),
      );
      expect({ name, generated }).toEqual({ name, generated: [] });
    }
  });

  it('as shipped, starts nothing: compose requires every secret, and the API would refuse too', () => {
    // Compose refuses to render a required variable that is empty or unset
    // (${VAR:?}), so neither container — LiveKit included — can start on the
    // example. Every secret is required by the compose files of this
    // environment, and every one is empty here.
    const { required } = variablesRead(environment);
    for (const name of secretsOf(environment)) {
      expect({ name, required: required.includes(name), value: variables.get(name) }).toEqual({
        name,
        required: true,
        value: '',
      });
    }
    // LiveKit receives its keys only through a required interpolation of
    // both — never a default that could stand in for them.
    expect(text(livekitEnvironment.LIVEKIT_KEYS, 'services.livekit.environment.LIVEKIT_KEYS')).toBe(
      '${LIVEKIT_API_KEY:?set it in the environment file}: ${LIVEKIT_API_SECRET:?set it in the environment file}',
    );
    // Rendered as compose renders it, neither container's environment can be
    // built: compose stops at the first empty secret, naming it.
    for (const [service, environment_] of [
      ['api', apiEnvironment],
      ['livekit', livekitEnvironment],
    ] as const) {
      expect({ service, rendered: rendering(environment_, variables) }).toEqual({
        service,
        rendered: expect.stringMatching(
          /^required variable (JWT_SECRET|STORAGE_SIGNING_SECRET|LIVEKIT_API_KEY|LIVEKIT_API_SECRET) is missing a value/,
        ) as string,
      });
    }
  });

  it('with generated secrets, boots the API on real media — and LiveKit gets the same pair', () => {
    const filled = completed(environment);
    expect(refusals(filled)).toEqual([]);
    const config = loadConfig(containerEnvironment(apiEnvironment, filled));
    expect(config.nodeEnv).toBe(environment);
    expect(config.live.mediaProvider).toBe('livekit');
    expect(config.live.roomNamePrefix).toBe(filled.get('LIVE_ROOM_NAME_PREFIX'));
    expect(config.livekit).toEqual({
      url: filled.get('LIVEKIT_URL'),
      // P7.3 / decision B: control reaches host-networked LiveKit at the bridge gateway.
      apiUrl: 'http://172.30.0.1:7880',
      apiKey: filled.get('LIVEKIT_API_KEY'),
      apiSecret: filled.get('LIVEKIT_API_SECRET'),
      version: PINNED_LIVEKIT_SERVER_VERSION,
    });
    expect(config.database.configured).toBe(deployed(environment));
    // One proxy hop in front of a deployed API: the TLS terminator.
    expect(config.http.trustProxy).toBe(deployed(environment) ? 1 : false);

    // LiveKit reads LIVEKIT_KEYS as a YAML map of key to secret (SRV
    // pkg/config/config.go:1090-1104): the generated pair survives it intact.
    const received = containerEnvironment(livekitEnvironment, filled);
    expect(load(received.LIVEKIT_KEYS ?? '', { schema: CORE_SCHEMA })).toStrictEqual({
      [filled.get('LIVEKIT_API_KEY') ?? '']: filled.get('LIVEKIT_API_SECRET'),
    });
    expect(received.NODE_IP).toBe(filled.get('LIVEKIT_NODE_IP'));
  });
});

describe('the environments together', () => {
  it('demand wss:// in staging and production, where the API refuses ws://', () => {
    for (const environment of DEPLOYED_ENVIRONMENTS) {
      const url = exampleOf(environment).get('LIVEKIT_URL') ?? '';
      expect(new URL(url).protocol).toBe('wss:');
      expect(clientUrlFault(url, true)).toBeNull();

      const insecure = completed(environment);
      insecure.set('LIVEKIT_URL', url.replace(/^wss:/, 'ws:'));
      expect(refusals(insecure)).toEqual([
        `LIVEKIT_URL must use wss:// in ${environment}: clients never connect in clear`,
      ]);
    }
    // Development connects on the developer's machine, where ws:// is allowed.
    expect(exampleOf('development').get('LIVEKIT_URL')).toBe('ws://localhost:7880');
  });

  it('give each environment its own LiveKit hosts and room prefix', () => {
    const distinct = (name: string, among: readonly Environment[]) =>
      new Set(among.map((environment) => exampleOf(environment).get(name))).size;
    expect(distinct('LIVEKIT_URL', ENVIRONMENTS)).toBe(ENVIRONMENTS.length);
    expect(distinct('LIVE_ROOM_NAME_PREFIX', ENVIRONMENTS)).toBe(ENVIRONMENTS.length);
    expect(distinct('LIVEKIT_TURN_DOMAIN', DEPLOYED_ENVIRONMENTS)).toBe(
      DEPLOYED_ENVIRONMENTS.length,
    );
    expect(distinct('LIVEKIT_NODE_IP', DEPLOYED_ENVIRONMENTS)).toBe(DEPLOYED_ENVIRONMENTS.length);
  });

  it('keep real environment files out of git', () => {
    expect(readRepoFile('infra/.gitignore').split('\n')).toContain('/env/*.env');
  });
});
