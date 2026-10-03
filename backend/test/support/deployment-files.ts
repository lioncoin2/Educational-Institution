import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CORE_SCHEMA, load } from 'js-yaml';

/**
 * The committed deployment files (P7.1), read the way their consumers read
 * them — YAML strictly (YAML 1.2's core schema; a duplicated key is an error,
 * as it is to Compose and to LiveKit), environment files as plain KEY=value
 * lines — plus the one piece of Compose the tests need to reproduce: turning
 * a service's `environment` into what its container receives.
 *
 * Every accessor names the path it expected, so a malformed file fails a
 * test precisely instead of with a TypeError.
 */

/** The repository root: infra/ and .github/ sit beside backend/. */
export const REPO_ROOT = join(__dirname, '..', '..', '..');

export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Staging and production: deployed, and run with LiveKit's embedded TURN. */
export const DEPLOYED_ENVIRONMENTS: readonly Environment[] = ['staging', 'production'];

export const COMPOSE_FILE = 'infra/compose.yaml';
export const TURN_OVERRIDE_FILE = 'infra/compose.turn.yaml';
/** P7.3 / D3: the data tier (Postgres, Redis), layered onto deployed environments. */
export const DATA_FILE = 'infra/compose.data.yaml';

export function exampleFile(environment: Environment): string {
  return `infra/env/${environment}.env.example`;
}

export function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

export function readYaml(path: string): unknown {
  return load(readRepoFile(path), { schema: CORE_SCHEMA, filename: path });
}

export type Mapping = Readonly<Record<string, unknown>>;

export function mapping(value: unknown, where: string): Mapping {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} is not a mapping`);
  }
  return value as Mapping;
}

export function sequence(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} is not a list`);
  return value as readonly unknown[];
}

export function text(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} is not a string`);
  return value;
}

export function texts(value: unknown, where: string): string[] {
  return sequence(value, where).map((item, index) => text(item, `${where}[${index}]`));
}

/** A compose file's services, by name. */
export function servicesOf(compose: unknown, where: string): Readonly<Record<string, Mapping>> {
  const services = mapping(mapping(compose, where).services, `${where}: services`);
  return Object.fromEntries(
    Object.entries(services).map(([name, service]) => [
      name,
      mapping(service, `${where}: services.${name}`),
    ]),
  );
}

/**
 * A service's `environment`, in the mapping form these files use: a string is
 * the text Compose interpolates; null passes the variable of that name
 * through, and only when the environment file sets it.
 */
export function environmentOf(service: Mapping, where: string): Record<string, string | null> {
  const environment = mapping(service.environment, `${where}.environment`);
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [
      name,
      value === null ? null : text(value, `${where}.environment.${name}`),
    ]),
  );
}

/** `${VAR}`, `${VAR:?message}` (required) and `${VAR:-default}`: the forms these files use. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:\?|:-)([^}]*))?\}/g;

export interface Reference {
  readonly name: string;
  readonly required: boolean;
}

/** The variables a compose value interpolates. Any other use of `$` is refused. */
export function referencesIn(template: string): Reference[] {
  // Compose escapes a literal dollar as `$$` (e.g. a shell variable the container
  // expands at runtime); it is not an interpolation. Remove escapes first, so
  // `$${VAR}` reads as the literal `${VAR}` and never as a reference to VAR.
  const unescaped = template.replace(/\$\$/g, '');
  if (unescaped.replace(REFERENCE, '').includes('$')) {
    throw new Error(`unsupported interpolation in ${JSON.stringify(template)}`);
  }
  return [...unescaped.matchAll(REFERENCE)].map((match) => ({
    name: match[1] ?? '',
    required: match[2] === ':?',
  }));
}

/** Every variable a compose document interpolates, anywhere; required if any use requires it. */
export function interpolatedVariables(document: unknown): Map<string, boolean> {
  const found = new Map<string, boolean>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const { name, required } of referencesIn(node)) {
        found.set(name, (found.get(name) ?? false) || required);
      }
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === 'object' && node !== null) {
      Object.values(node).forEach(visit);
    }
  };
  visit(document);
  return found;
}

/** Compose's interpolation of one value. A required variable unset or empty throws, as Compose refuses. */
export function interpolate(template: string, variables: ReadonlyMap<string, string>): string {
  referencesIn(template);
  // Handle the `$$` literal-dollar escape and `${...}` references in one
  // left-to-right pass, so `$${VAR}` renders as the literal `${VAR}`.
  return template.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:\?|:-)([^}]*))?\}/g,
    (whole: string, name: string, operator: string | undefined, argument: string | undefined) => {
      if (whole === '$$') return '$';
      const value = variables.get(name);
      const missing = value === undefined || value === '';
      if (operator === ':?' && missing) {
        throw new Error(`required variable ${name} is missing a value: ${argument ?? ''}`);
      }
      if (operator === ':-' && missing) return argument ?? '';
      return value ?? '';
    },
  );
}

/** What a container receives: each value interpolated; a pass-through only when the file sets it. */
export function containerEnvironment(
  environment: Readonly<Record<string, string | null>>,
  variables: ReadonlyMap<string, string>,
): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== null) rendered[name] = interpolate(value, variables);
    else if (variables.has(name)) rendered[name] = variables.get(name) ?? '';
  }
  return rendered;
}

const ENV_LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/**
 * An environment file, kept to the subset whose meaning is not in doubt:
 * KEY=value lines, whole-line comments and blank lines. A quote, an inline
 * comment or surrounding whitespace — each of which Compose would
 * reinterpret — is refused, as is a variable set twice.
 */
export function readEnvFile(path: string): Map<string, string> {
  const variables = new Map<string, string>();
  readRepoFile(path)
    .split('\n')
    .forEach((line, index) => {
      if (line === '' || line.startsWith('#')) return;
      const where = `${path}:${index + 1}`;
      const match = ENV_LINE.exec(line);
      if (match === null) throw new Error(`${where} is not a KEY=value line`);
      const [, name = '', value = ''] = match;
      if (/["'`]| #|^\s|\s$/.test(value)) {
        throw new Error(`${where}: no quotes, inline comments or surrounding spaces`);
      }
      if (variables.has(name)) throw new Error(`${where}: ${name} is set twice`);
      variables.set(name, value);
    });
  return variables;
}
