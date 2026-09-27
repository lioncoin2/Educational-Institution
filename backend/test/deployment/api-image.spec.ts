import { mapping, readRepoFile, readYaml, sequence } from '../support/deployment-files';

/**
 * The API image, backend/Dockerfile (P7.1, decision 9): a small multi-stage
 * Node 22 build that runs `node dist/main.js` as a non-root user, with no
 * secret baked in. The properties, each asserted on its own:
 *
 *   - two stages from one Node 22 image pinned by digest — the major version
 *     CI tests with;
 *   - the runtime runs `node dist/main.js` as the image's `node` user, and
 *     defaults to the strictest environment;
 *   - no build argument, no environment value but NODE_ENV, no file fetched
 *     or copied beyond the build's inputs, no install script run;
 *   - the build context (.dockerignore) holds exactly those inputs: never a
 *     .env file, local storage, node_modules or tests.
 */

interface Instruction {
  readonly keyword: string;
  readonly argument: string;
}

/** The Dockerfile's instructions, one per line: a continuation line would be refused here. */
function instructions(): Instruction[] {
  return readRepoFile('backend/Dockerfile')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => {
      const match = /^([A-Z]+) (.+)$/.exec(line);
      if (match === null) throw new Error(`not one instruction per line: ${line}`);
      return { keyword: match[1] ?? '', argument: match[2] ?? '' };
    });
}

const all = instructions();
const argumentsOf = (keyword: string) =>
  all.filter((instruction) => instruction.keyword === keyword).map(({ argument }) => argument);
/** The instructions of the last stage: what the running image is made of. */
const runtimeStage = all.slice(all.map(({ keyword }) => keyword).lastIndexOf('FROM'));

describe('the API image', () => {
  it('builds in two stages from one pinned Node 22 image — the version CI tests with', () => {
    const stages = argumentsOf('FROM');
    expect(stages).toEqual([
      expect.stringMatching(/ AS build$/) as string,
      expect.stringMatching(/ AS runtime$/) as string,
    ]);
    const images = new Set(stages.map((stage) => stage.replace(/ AS \w+$/, '')));
    expect(images.size).toBe(1);
    const [image = ''] = images;
    expect(image).toMatch(/^node:22\.\d+\.\d+-alpine[\d.]+@sha256:[0-9a-f]{64}$/);

    const ci = mapping(readYaml('.github/workflows/ci.yml'), 'ci.yml');
    const backend = mapping(mapping(ci.jobs, 'jobs').backend, 'jobs.backend');
    const setupNode = sequence(backend.steps, 'jobs.backend.steps')
      .map((step, index) => mapping(step, `jobs.backend.steps[${index}]`))
      .find((step) => String(step.uses).startsWith('actions/setup-node@'));
    expect(mapping(setupNode?.with, 'setup-node.with')['node-version']).toBe(
      Number(/^node:(\d+)\./.exec(image)?.[1]),
    );
  });

  it('runs `node dist/main.js` as the unprivileged node user, strict by default', () => {
    expect(argumentsOf('CMD')).toEqual(['["node", "dist/main.js"]']);
    expect(argumentsOf('ENTRYPOINT')).toEqual([]);
    // The last word on the user, after every step that needs root.
    const lastUser = runtimeStage.map(({ keyword }) => keyword).lastIndexOf('USER');
    expect(runtimeStage[lastUser]?.argument).toBe('node');
    expect(runtimeStage.slice(lastUser).map(({ keyword }) => keyword)).not.toContain('RUN');
    // Started without NODE_ENV, the API checks itself as production.
    expect(argumentsOf('ENV')).toEqual(['NODE_ENV=production']);
  });

  it('bakes nothing secret in: no build argument, no fetched or stray file, no install script', () => {
    expect(argumentsOf('ARG')).toEqual([]);
    expect(argumentsOf('ADD')).toEqual([]);
    // The runtime copies the package manifests and the compiled output — nothing else.
    expect(
      runtimeStage.filter(({ keyword }) => keyword === 'COPY').map(({ argument }) => argument),
    ).toEqual(['package.json package-lock.json ./', '--from=build /app/dist ./dist']);
    for (const install of argumentsOf('RUN').filter((run) => run.startsWith('npm ci'))) {
      expect(install).toContain('--ignore-scripts');
    }
    expect(argumentsOf('RUN')).toContain(
      'npm ci --omit=dev --ignore-scripts && npm cache clean --force',
    );
  });

  it('builds from a context holding exactly its inputs — never a .env file', () => {
    const rules = readRepoFile('backend/.dockerignore')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'));
    // Everything out first, then only the inputs back in.
    expect(rules[0]).toBe('*');
    const allowed = rules.filter((rule) => rule.startsWith('!')).map((rule) => rule.slice(1));
    expect(allowed).toEqual([
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'src',
    ]);
    expect(allowed.filter((path) => path.includes('.env'))).toEqual([]);

    // Every file the Dockerfile copies from the context is one the context lets in.
    const copied = argumentsOf('COPY')
      .filter((argument) => !argument.startsWith('--from='))
      .flatMap((argument) => argument.split(' ').slice(0, -1));
    expect(copied.filter((source) => !allowed.includes(source))).toEqual([]);
  });
});
