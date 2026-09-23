import { createRequire } from 'node:module';
import { join } from 'node:path';

import { cruise, type CruiseOutput } from '../support/dependency-graph';

/**
 * A forbidden rule that matches nothing always passes.
 *
 * That is not hypothetical: `application-has-no-vendor-sdks` compared its
 * target against the bare package name ("^livekit-server-sdk") while
 * dependency-cruiser compares against the RESOLVED path
 * ("node_modules/livekit-server-sdk/dist/index.js"), so it could never fire,
 * and the build stayed green whatever an application layer imported.
 *
 * This suite makes every forbidden rule that names a target path prove it can
 * match: each one has a representative (from, to) pair here, and the pair must
 * satisfy the rule exactly as dependency-cruiser would evaluate it. Where the
 * target is a package the backend really imports, the representative path is
 * taken from the live dependency graph, not written by hand. A new rule
 * without a representative fails the suite, so none can be added vacuous.
 */

type Patterns = string | readonly string[] | undefined;

interface Condition {
  readonly path?: string | readonly string[];
  readonly pathNot?: string | readonly string[];
  readonly dependencyTypes?: readonly string[];
  readonly circular?: boolean;
  readonly reachable?: boolean;
}

interface ForbiddenRule {
  readonly name: string;
  readonly severity: string;
  readonly from: Condition;
  readonly to: Condition;
}

const ROOT = join(__dirname, '..', '..');
const { forbidden } = createRequire(__filename)(join(ROOT, '.dependency-cruiser.cjs')) as {
  forbidden: readonly ForbiddenRule[];
};

const list = (patterns: Patterns): readonly string[] =>
  patterns === undefined ? [] : typeof patterns === 'string' ? [patterns] : patterns;

/** The first capture group of the first `from.path` pattern that matches — dependency-cruiser's `$1`. */
function fromGroup(rule: ForbiddenRule, source: string): string | undefined {
  for (const pattern of list(rule.from.path)) {
    const match = new RegExp(pattern).exec(source);
    if (match) return match[1];
  }
  return undefined;
}

function fromMatches(rule: ForbiddenRule, source: string): boolean {
  const paths = list(rule.from.path);
  const included = paths.length === 0 || paths.some((p) => new RegExp(p).test(source));
  const excluded = list(rule.from.pathNot).some((p) => new RegExp(p).test(source));
  return included && !excluded;
}

function toMatches(rule: ForbiddenRule, source: string, target: string): boolean {
  const group = fromGroup(rule, source);
  const substitute = (pattern: string) =>
    group === undefined ? pattern : pattern.split('$1').join(group);
  const included = list(rule.to.path).some((p) => new RegExp(substitute(p)).test(target));
  const excluded = list(rule.to.pathNot).some((p) => new RegExp(substitute(p)).test(target));
  return included && !excluded;
}

describe('every forbidden rule can fire', () => {
  let output: CruiseOutput;
  let resolved: string[];

  beforeAll(() => {
    output = cruise();
    resolved = output.modules.flatMap((module) => module.dependencies.map((d) => d.resolved));
  }, 180_000);

  /** A path the backend really resolves today, so the sample is not invented. */
  const real = (prefix: string): string => {
    const found = resolved.find((path) => path.startsWith(prefix));
    if (found === undefined) throw new Error(`no resolved path in the graph starts with ${prefix}`);
    return found;
  };

  /**
   * One violating edge per rule with a target path. Functions, because some
   * read the graph. Packages that are deliberately not installed (push SDKs,
   * socket.io) use the shape dependency-cruiser would resolve them to.
   */
  const SAMPLES: Readonly<Record<string, () => { from: string; to: string }>> = {
    'domain-reaches-no-npm': () => ({
      from: 'src/modules/live/domain/speaker-request.ts',
      to: real('node_modules/@nestjs/common/'),
    }),
    'shared-kernel-reaches-no-npm': () => ({
      from: 'src/shared/result.ts',
      to: real('node_modules/@nestjs/common/'),
    }),
    'domain-does-not-look-outward': () => ({
      from: 'src/modules/live/domain/live-room.ts',
      to: 'src/modules/live/application/join-live-session.use-case.ts',
    }),
    'application-does-not-touch-adapters': () => ({
      from: 'src/modules/live/application/join-live-session.use-case.ts',
      to: 'src/modules/live/infrastructure/livekit-rtc-provider.ts',
    }),
    'application-has-no-vendor-sdks': () => ({
      from: 'src/modules/live/application/join-live-session.use-case.ts',
      to: real('node_modules/livekit-server-sdk/'),
    }),
    'livekit-sdk-only-in-the-live-adapter': () => ({
      from: 'src/modules/messaging/infrastructure/drizzle-messaging-repository.ts',
      to: real('node_modules/livekit-server-sdk/'),
    }),
    'websocket-library-only-in-the-realtime-adapter': () => ({
      from: 'src/modules/messaging/application/send-message.use-cases.ts',
      to: real('node_modules/ws/'),
    }),
    'push-sdks-only-in-the-notifications-adapter': () => ({
      from: 'src/modules/messaging/application/send-message.use-cases.ts',
      to: 'node_modules/firebase-admin/lib/index.js',
    }),
    'api-does-not-touch-adapters': () => ({
      from: 'src/modules/live/api/live.controller.ts',
      to: 'src/modules/live/infrastructure/fake-rtc-provider.ts',
    }),
    'api-does-not-touch-domain-internals': () => ({
      from: 'src/modules/live/api/live.controller.ts',
      to: 'src/modules/live/domain/live-room.ts',
    }),
    'no-cross-module-internals': () => ({
      from: 'src/modules/messaging/application/send-message.use-cases.ts',
      to: 'src/modules/live/domain/live-room.ts',
    }),
    'contracts-are-self-contained': () => ({
      from: 'src/modules/live/contracts/events.ts',
      to: 'src/modules/live/domain/live-room.ts',
    }),
    'platform-knows-no-modules': () => ({
      from: 'src/platform/http/http-failure.ts',
      to: 'src/modules/live/contracts/index.ts',
    }),
    'shared-kernel-is-pure': () => ({
      from: 'src/shared/result.ts',
      to: 'src/platform/http/http-failure.ts',
    }),
    'no-secrets-outside-config': () => ({
      from: 'src/modules/live/application/join-live-session.use-case.ts',
      to: 'node_modules/dotenv/lib/main.js',
    }),
  };

  const withTargetPath = forbidden.filter((rule) => list(rule.to.path).length > 0);

  it('has a representative violation for every rule that names a target path — and no stale ones', () => {
    expect(withTargetPath.length).toBeGreaterThan(10);
    expect(withTargetPath.map((rule) => rule.name).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each(Object.keys(SAMPLES))('%s matches its representative violation', (name) => {
    const rule = forbidden.find((candidate) => candidate.name === name);
    expect(rule).toBeDefined();
    const sample = SAMPLES[name]();
    expect({ name, from: fromMatches(rule!, sample.from) }).toEqual({ name, from: true });
    expect({ name, to: toMatches(rule!, sample.from, sample.to) }).toEqual({ name, to: true });
  });

  // The regression this suite exists for, stated on its own: the vendor rule
  // would have failed the check above as it was written before.
  it('would have caught the anchored vendor pattern', () => {
    const anchoredAtThePackage: ForbiddenRule = {
      name: 'as-it-was',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/application/' },
      to: { path: '^(livekit-server-sdk|drizzle-orm)' },
    };
    const source = 'src/modules/live/application/join-live-session.use-case.ts';
    expect(toMatches(anchoredAtThePackage, source, real('node_modules/livekit-server-sdk/'))).toBe(
      false,
    );
  });

  it('does not match what each rule allows — the samples are not matching everything', () => {
    const allowed: Readonly<Record<string, { from: string; to: string }>> = {
      'livekit-sdk-only-in-the-live-adapter': {
        from: 'src/modules/live/infrastructure/livekit-rtc-provider.ts',
        to: real('node_modules/livekit-server-sdk/'),
      },
      'application-has-no-vendor-sdks': {
        from: 'src/modules/live/application/join-live-session.use-case.ts',
        to: real('node_modules/@nestjs/common/'),
      },
      'no-cross-module-internals': {
        from: 'src/modules/realtime/application/messaging-relay.ts',
        to: 'src/modules/messaging/contracts/message-recipients.ts',
      },
    };
    for (const [name, sample] of Object.entries(allowed)) {
      const rule = forbidden.find((candidate) => candidate.name === name)!;
      const violates = fromMatches(rule, sample.from) && toMatches(rule, sample.from, sample.to);
      expect({ name, violates }).toEqual({ name, violates: false });
    }
  });
});
