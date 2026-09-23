/**
 * Architectural boundaries, enforced.
 *
 * These rules are the executable form of docs/architecture/dependency-rules.md.
 * They run in `npm run verify` and in CI, so an illegal import fails the build
 * rather than quietly eroding the architecture.
 *
 * Layering inside a module:
 *   api  ->  application  ->  domain
 *   infrastructure -> domain (implements its ports)
 *
 * Across modules: ONLY `contracts/` is public. Everything else is internal.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies make modules impossible to extract into a service later.',
      from: {},
      to: { circular: true },
    },

    // ── Domain purity ────────────────────────────────────────────────────
    {
      name: 'domain-is-dependency-free',
      severity: 'error',
      comment:
        'The domain layer must not import ANY npm package or node core module. ' +
        'No Nest, no LiveKit, no Drizzle/pg, no Redis, no HTTP framework. ' +
        'Anything the domain needs from the outside world is expressed as a port ' +
        '(an interface it owns) and implemented in infrastructure.',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: { dependencyTypes: ['npm', 'core'] },
    },
    {
      name: 'domain-does-not-look-outward',
      severity: 'error',
      comment:
        'The domain must not depend on the layers that depend on it, nor on platform.',
      from: { path: '^src/modules/[^/]+/domain/' },
      to: {
        path: [
          '^src/modules/[^/]+/(application|infrastructure|api)/',
          '^src/platform/',
        ],
      },
    },

    // ── Application layer ────────────────────────────────────────────────
    {
      name: 'application-does-not-touch-adapters',
      severity: 'error',
      comment:
        'Use cases orchestrate the domain through ports. They must never reach into ' +
        'infrastructure (adapters) or api (transport) directly.',
      from: { path: '^src/modules/[^/]+/application/' },
      to: { path: '^src/modules/[^/]+/(infrastructure|api)/' },
    },
    {
      name: 'application-has-no-vendor-sdks',
      severity: 'error',
      comment:
        'Vendor SDKs belong in infrastructure adapters only, behind a port. ' +
        '@nestjs/common is permitted for DI decorators.',
      from: { path: '^src/modules/[^/]+/application/' },
      to: {
        dependencyTypes: ['npm'],
        path: '^(livekit-server-sdk|drizzle-orm|pg|ioredis|express|@nestjs/platform-express|nestjs-pino|pino)',
      },
    },

    // ── API layer ────────────────────────────────────────────────────────
    {
      name: 'api-does-not-touch-adapters',
      severity: 'error',
      comment:
        'Controllers depend on use cases, never on adapters. This keeps transport ' +
        'swappable and stops business logic leaking into the presentation edge.',
      from: { path: '^src/modules/[^/]+/api/' },
      to: { path: '^src/modules/[^/]+/infrastructure/' },
    },
    {
      name: 'api-does-not-touch-domain-internals',
      severity: 'error',
      comment:
        'Controllers speak application DTOs, not domain entities. Domain objects must ' +
        'not be serialized straight onto the wire.',
      from: { path: '^src/modules/[^/]+/api/' },
      to: { path: '^src/modules/[^/]+/domain/' },
    },

    // ── Module boundaries ────────────────────────────────────────────────
    {
      name: 'no-cross-module-internals',
      severity: 'error',
      comment:
        'A module may only reach another module through its public `contracts/` ' +
        'directory (or via events). Reaching into another module\'s domain, ' +
        'application, infrastructure or api couples them permanently. ' +
        'A module\'s root `<name>.module.ts` is also allowed: in Nest the module ' +
        'class IS the composition surface — importing it grants access to exactly ' +
        'what that module lists in `exports`, and nothing more. The code-level ' +
        'boundary is still enforced, because whatever is exported can only be ' +
        'referred to through `contracts/`.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: [
          '^src/modules/$1/',
          '^src/modules/[^/]+/contracts/',
          '^src/modules/[^/]+/[^/]+\\.module\\.ts$',
        ],
      },
    },
    {
      name: 'contracts-are-self-contained',
      severity: 'error',
      comment:
        'A public contract must not drag a module\'s internals along with it. ' +
        'Contracts may only use shared kernel types and other contracts.',
      from: { path: '^src/modules/[^/]+/contracts/' },
      to: {
        path: '^src/modules/[^/]+/(domain|application|infrastructure|api)/',
      },
    },

    // ── Platform & shared kernel ─────────────────────────────────────────
    {
      name: 'platform-knows-no-modules',
      severity: 'error',
      comment:
        'Platform is the technical substrate (config, logging, db, redis, event bus). ' +
        'If it depended on a business module the monolith could never be split.',
      from: { path: '^src/platform/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'shared-kernel-is-pure',
      severity: 'error',
      comment:
        'The shared kernel is imported by every layer including domain, so it must stay ' +
        'free of frameworks, vendor SDKs and business modules.',
      from: { path: '^src/shared/' },
      to: {
        path: ['^src/platform/', '^src/modules/'],
      },
    },
    {
      name: 'shared-kernel-has-no-npm',
      severity: 'error',
      comment: 'The shared kernel must be as dependency-free as the domain it serves.',
      from: { path: '^src/shared/' },
      to: { dependencyTypes: ['npm'] },
    },

    // ── Hygiene ──────────────────────────────────────────────────────────
    {
      name: 'no-secrets-outside-config',
      severity: 'error',
      comment:
        'process.env must only be read by the config module, so every setting is ' +
        'validated once and nothing reads undeclared configuration.',
      from: { path: '^src/', pathNot: '^src/platform/config/' },
      to: { path: '^node_modules/dotenv' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '\\.spec\\.ts$' },
    reporterOptions: {
      archi: { collapsePattern: '^src/(modules/[^/]+|platform/[^/]+|shared)' },
    },
  },
};
