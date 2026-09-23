import { cruise, edgesFrom, reachableFrom, type CruiseOutput } from '../support/dependency-graph';

/**
 * The shape of academic, asserted — each property the Academic Core V1 brief
 * names as its own test, so a failure says which one broke:
 *
 *   - academic knows identity only through identity's contracts, and no other
 *     module at all (messaging, files, realtime, notifications);
 *   - no other module reaches academic's internals: its contracts are the way
 *     in (the composition root and the seeding CLI aside);
 *   - academic never reads another module's tables — identity's, messaging's,
 *     notifications', files' — and nobody else reads academic's;
 *   - the academic domain is pure, and neither it nor the application layer
 *     reaches Drizzle, pg, a WebSocket library, Firebase, an HTTP controller
 *     or DTO, or any notification infrastructure.
 */
const VENDOR_OR_TRANSPORT =
  /^node_modules\/(@types\/)?(drizzle-orm|pg|pg-[^/]+|ws|socket\.io|express|ioredis|firebase|firebase-admin|@firebase\/[^/]+|livekit-server-sdk)\//;

const OTHER_SCHEMAS = [
  'src/modules/identity/infrastructure/schema.ts',
  'src/modules/messaging/infrastructure/schema.ts',
  'src/modules/notifications/infrastructure/schema.ts',
  'src/modules/files/infrastructure/schema.ts',
  'src/modules/communities/infrastructure/schema.ts',
];

const ACADEMIC = 'src/modules/academic/';
const ACADEMIC_SCHEMA = 'src/modules/academic/infrastructure/schema.ts';
const isAcademicCode = (source: string) =>
  source.startsWith(ACADEMIC) && source !== 'src/modules/academic/academic.module.ts';

describe('academic boundaries', () => {
  let output: CruiseOutput;

  beforeAll(() => {
    output = cruise();
  }, 180_000);

  const reaching = (from: (source: string) => boolean, target: (path: string) => boolean) =>
    [...reachableFrom(output, from)].filter(target);

  it('was analysed — its layers are all in the graph', () => {
    const sources = output.modules.map((module) => module.source);
    for (const file of [
      'src/modules/academic/domain/structure.ts',
      'src/modules/academic/domain/enrollment.ts',
      'src/modules/academic/application/enrollment.use-cases.ts',
      'src/modules/academic/infrastructure/drizzle-academic-repository.ts',
      'src/modules/academic/api/relationships.controller.ts',
      'src/modules/academic/contracts/relationships.ts',
      ACADEMIC_SCHEMA,
      ...OTHER_SCHEMAS,
    ]) {
      expect(sources).toContain(file);
    }
  });

  it('knows identity only through its contracts, and no other module at all', () => {
    const intrusions = edgesFrom(output, isAcademicCode)
      .filter((edge) => edge.resolved.startsWith('src/modules/'))
      .filter((edge) => !edge.resolved.startsWith(ACADEMIC))
      .filter((edge) => !edge.resolved.startsWith('src/modules/identity/contracts/'))
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
    // The module file wires identity in, and nothing else.
    const wiring = edgesFrom(
      output,
      (source) => source === 'src/modules/academic/academic.module.ts',
    )
      .map((edge) => edge.resolved)
      .filter((path) => path.startsWith('src/modules/') && !path.startsWith(ACADEMIC));
    expect(wiring).toEqual(['src/modules/identity/identity.module.ts']);
  });

  it('is reached by other modules only through its contracts', () => {
    const intrusions = edgesFrom(output, (source) => !source.startsWith(ACADEMIC))
      .filter((edge) => edge.resolved.startsWith(ACADEMIC))
      .filter(
        (edge) =>
          !edge.resolved.startsWith('src/modules/academic/contracts/') &&
          edge.resolved !== 'src/modules/academic/academic.module.ts',
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`)
      // Composition roots assemble the application; they are not modules.
      .filter((edge) => !/^src\/(app\.module|main|cli\/)/.test(edge));
    expect(intrusions).toEqual([]);
  });

  it('never reads identity’s, messaging’s, notifications’, files’ or communities’ tables', () => {
    expect(reaching(isAcademicCode, (path) => OTHER_SCHEMAS.includes(path))).toEqual([]);
    // Non-vacuous: academic's own adapters do reach a schema — their own.
    expect(reaching(isAcademicCode, (path) => path === ACADEMIC_SCHEMA)).toEqual([ACADEMIC_SCHEMA]);
  });

  it('lets only academic’s own adapters touch academic’s tables', () => {
    const importers = edgesFrom(
      output,
      (source) => !source.startsWith('src/modules/academic/infrastructure/'),
    )
      .filter((edge) => edge.resolved === ACADEMIC_SCHEMA)
      .map((edge) => edge.source);
    expect(importers).toEqual([]);
  });

  it('keeps the domain pure: itself, its own contracts and the shared kernel only', () => {
    const reachable = [
      ...reachableFrom(output, (source) => source.startsWith(`${ACADEMIC}domain/`)),
    ];
    const outside = reachable.filter(
      (target) =>
        !target.startsWith(`${ACADEMIC}domain/`) &&
        !target.startsWith(`${ACADEMIC}contracts/`) &&
        !target.startsWith('src/shared/'),
    );
    expect(outside).toEqual([]);
    expect(reachable.filter((target) => target.startsWith('node_modules/'))).toEqual([]);
    expect(reachable).toContain(`${ACADEMIC}domain/text.ts`);
  });

  it('keeps the domain and application free of Drizzle, pg, sockets, Firebase and HTTP', () => {
    const logic = (source: string) =>
      /^src\/modules\/academic\/(domain|application)\//.test(source);
    expect(reaching(logic, (path) => VENDOR_OR_TRANSPORT.test(path))).toEqual([]);
    expect(
      reaching(
        logic,
        (path) =>
          path.startsWith(`${ACADEMIC}api/`) ||
          path.startsWith(`${ACADEMIC}infrastructure/`) ||
          path.startsWith('src/platform/database/') ||
          path.startsWith('src/platform/http/') ||
          path.startsWith('src/modules/notifications/') ||
          path.startsWith('src/modules/realtime/'),
      ),
    ).toEqual([]);
  });

  it('publishes a self-contained contract — itself and the shared kernel, no framework', () => {
    const contract = [
      ...reachableFrom(output, (source) => source.startsWith(`${ACADEMIC}contracts/`)),
    ];
    expect(
      contract.filter(
        (path) => !path.startsWith(`${ACADEMIC}contracts/`) && !path.startsWith('src/shared/'),
      ),
    ).toEqual([]);
    expect(contract).toContain('src/shared/domain-event.ts');
  });
});
