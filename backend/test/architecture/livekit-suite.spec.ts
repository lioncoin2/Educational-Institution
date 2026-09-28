import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

import { PINNED_LIVEKIT_SERVER_VERSION } from '../../src/platform/config/livekit-config';
import { mapping, readYaml, sequence, text } from '../support/deployment-files';
import { RELEASE_CACHE } from '../livekit/support/pinned-release';

const ROOT = join(__dirname, '..', '..');
const load = createRequire(__filename);

/** An import of LiveKit's WebRTC client, or of its native bindings, as source text writes it. */
const NAMES_THE_CLIENT =
  /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)['"]@livekit\/(?:rtc-node|rtc-ffi-bindings)[^'"]*['"]/;

/** A test left out, focused or left to do. */
const NOT_RUN =
  /\b(?:it|test|describe)\.(?:skip|only|todo)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\(/;

/** Every script file under `dir` (relative to the backend). */
function scriptFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|js|cjs|mjs)$/.test(entry.name))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

interface JestConfig {
  readonly rootDir?: string;
  readonly roots?: readonly string[];
  readonly testPathIgnorePatterns?: readonly string[];
  readonly globalSetup?: string;
  readonly globalTeardown?: string;
}

interface PackageManifest {
  readonly scripts: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

/**
 * The real LiveKit suite (P7.1) and the WebRTC client it drives, kept where
 * they belong. The properties, each asserted on its own:
 *
 *   - LiveKit's own client (`@livekit/rtc-node`, with its native bindings)
 *     is named by the real suite under test/livekit/ and by no other file —
 *     never under src/, which the build forbids as well
 *     (`webrtc-client-never-in-src`);
 *   - it is never shipped: a devDependency, pinned exactly, which the image's
 *     `npm ci --omit=dev` leaves out;
 *   - the real suite is its own run: `npm test` excludes it rather than
 *     skipping it, `npm run test:livekit` runs it with its own lifecycle —
 *     the pinned server started and stopped for it — and nothing in it is
 *     skipped, focused or left to do;
 *   - the release it downloads stays out of the repository, cached per
 *     version — and CI runs the suite in a job of its own, with that cache
 *     keyed on the version the application pins.
 */
describe('the real LiveKit suite and its WebRTC client', () => {
  const manifest = JSON.parse(read('package.json')) as PackageManifest;

  it('names the WebRTC client under test/livekit/ only — never in src/, nowhere else in the tests', () => {
    const naming = [...scriptFiles('src'), ...scriptFiles('test')].filter((file) =>
      NAMES_THE_CLIENT.test(read(file)),
    );
    // Not vacuous: the suite's client does.
    expect(naming).toContain('test/livekit/support/media-client.ts');
    expect(naming.filter((file) => !file.startsWith('test/livekit/'))).toEqual([]);

    const { forbidden } = load(join(ROOT, '.dependency-cruiser.cjs')) as {
      forbidden: ReadonlyArray<{ name: string; from: { path?: string }; to: { path?: string } }>;
    };
    expect(forbidden.find((rule) => rule.name === 'webrtc-client-never-in-src')).toMatchObject({
      from: { path: '^src/' },
      to: { path: expect.stringContaining('rtc-node') as string },
    });
  });

  it('never ships it: a devDependency, pinned at exactly 1.1.0', () => {
    expect(manifest.dependencies['@livekit/rtc-node']).toBeUndefined();
    expect(manifest.devDependencies['@livekit/rtc-node']).toBe('1.1.0');
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Readonly<Record<string, { version?: string; dev?: boolean }>>;
    };
    expect(lock.packages['node_modules/@livekit/rtc-node']).toMatchObject({
      version: '1.1.0',
      dev: true,
    });
  });

  // P7.2 (audit §8): the adapter's behaviour — its errors, its token claims —
  // is proven against one SDK release; a range would let another in unseen.
  it('pins the LiveKit server SDK the adapter runs at exactly the release it is tested against', () => {
    expect(manifest.dependencies['livekit-server-sdk']).toBe('2.19.1');
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Readonly<
        Record<string, { version?: string; dependencies?: Readonly<Record<string, string>> }>
      >;
    };
    expect(lock.packages['']?.dependencies?.['livekit-server-sdk']).toBe('2.19.1');
    expect(lock.packages['node_modules/livekit-server-sdk']?.version).toBe('2.19.1');
  });

  it('runs the suite on its own: excluded from npm test — never skipped — with its own server lifecycle', () => {
    const main = load(join(ROOT, 'jest.config.js')) as JestConfig;
    expect(main.testPathIgnorePatterns).toContain('<rootDir>/test/livekit/');

    const suite = load(join(ROOT, 'test', 'livekit', 'jest.config.js')) as JestConfig;
    expect(suite).toMatchObject({
      rootDir: '../..',
      roots: ['<rootDir>/test/livekit'],
      globalSetup: '<rootDir>/test/livekit/global-setup.ts',
      globalTeardown: '<rootDir>/test/livekit/global-teardown.ts',
    });
    expect(suite.testPathIgnorePatterns).not.toContain('<rootDir>/test/livekit/');
    expect(manifest.scripts['test:livekit']).toBe('jest --config test/livekit/jest.config.js');

    const specs = scriptFiles('test/livekit').filter((file) => file.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThanOrEqual(5);
    expect(specs.filter((file) => NOT_RUN.test(read(file)))).toEqual([]);
  });

  it('keeps the release it downloads out of the repository, cached per version', () => {
    expect(read('.gitignore').split('\n')).toContain('.cache/');
    expect(relative(ROOT, RELEASE_CACHE)).toBe(
      join('.cache', 'livekit', PINNED_LIVEKIT_SERVER_VERSION),
    );
  });

  it('is run by CI in a job of its own, the release cached under the version the application pins', () => {
    const ci = mapping(readYaml('.github/workflows/ci.yml'), 'ci.yml');
    const jobs = Object.values(mapping(ci.jobs, 'jobs')).map((job, index) =>
      mapping(job, `jobs[${index}]`),
    );
    const stepsOf = (job: Readonly<Record<string, unknown>>) =>
      sequence(job.steps, 'steps').map((step, index) => mapping(step, `steps[${index}]`));
    const suiteJobs = jobs.filter((job) =>
      stepsOf(job).some((step) => step.run === 'npm run test:livekit'),
    );
    expect(suiteJobs).toHaveLength(1);
    const [job] = suiteJobs;
    const steps = stepsOf(job ?? {});
    // The main job runs npm run verify: not this suite, which has its own.
    expect(steps.some((step) => step.run === 'npm run verify')).toBe(false);
    expect(mapping(mapping(job?.defaults, 'defaults').run, 'defaults.run')).toEqual({
      'working-directory': 'backend',
    });
    expect(steps.map((step) => step.run)).toContain('npm ci');

    // The version is read from the constant that pins it…
    const pin = steps.find((step) => step.id === 'livekit');
    expect(text(pin?.run, 'the version step')).toContain('PINNED_LIVEKIT_SERVER_VERSION = ');
    expect(text(pin?.run, 'the version step')).toContain('src/platform/config/livekit-config.ts');
    expect(read('src/platform/config/livekit-config.ts').split('\n')).toContain(
      `export const PINNED_LIVEKIT_SERVER_VERSION = '${PINNED_LIVEKIT_SERVER_VERSION}';`,
    );
    // …and keys the cache of the release archive.
    const cache = steps.find((step) => String(step.uses).startsWith('actions/cache@'));
    expect(mapping(cache?.with, 'the cache step')).toEqual({
      path: 'backend/.cache/livekit',
      key: expect.stringContaining('${{ steps.livekit.outputs.version }}') as string,
    });
    // Cached before the suite runs.
    expect(steps.indexOf(cache ?? {})).toBeLessThan(
      steps.findIndex((step) => step.run === 'npm run test:livekit'),
    );
  });
});
