import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { cruise, edgesFrom, reachableFrom, type CruiseOutput } from '../support/dependency-graph';

/**
 * The shape of attendance, asserted (attendance.md §22) — each property on its
 * own, so a failure says which boundary broke:
 *
 *   - attendance knows identity, Communities and Live only through their
 *     contracts, and no other module at all — not messaging, realtime,
 *     notifications, academic, operations or files; its module file wires
 *     exactly Identity, Communities and Live;
 *   - no other module reaches attendance's internals; attendance is reached at
 *     all only by the composition root and — for its public event contract
 *     (`contracts/`) — by notifications, whose translator subscribes to
 *     `attendance.snapshot.recorded`; notifications reaches no attendance
 *     internal (P10, Q67);
 *   - the domain is pure (itself, its contracts and the shared kernel); the
 *     domain and application reach no vendor SDK or transport; `drizzle-orm`
 *     and `pg` live only in infrastructure;
 *   - LiveKit and socket libraries are reached nowhere in attendance — presence
 *     is read through Live's principal-less contract, never the media SDK;
 *   - attendance uses Communities only through `COMMUNITY_AUTHORIZATION`, never
 *     `COMMUNITY_MEMBERSHIP` or `COMMUNITY_CAPABILITY_HOLDERS` (§11.2/§22);
 *   - no `attendance.read` / `attendance.manage` identity permission appears in
 *     the module (§11.2 — those stay reserved for operations);
 *   - attendance reads no other module's tables, and only its own adapters
 *     touch its tables; its contracts carry only the shared kernel.
 *
 * (The repo-wide no-`forwardRef` guard is owned by `boundaries.spec.ts`; the
 * "only attendance and the app import `live/contracts/presence.ts`" allow-list
 * is owned, from Live's side, by `live-boundaries.spec.ts`; "CommunitiesModule
 * imports neither Live nor Attendance" is owned by `communities-boundaries.spec.ts`
 * through its module-wiring assertion. They are not duplicated here.)
 */
const VENDOR_OR_TRANSPORT =
  /^node_modules\/(@types\/)?(drizzle-orm|pg|pg-[^/]+|ws|socket\.io|express|ioredis|firebase|firebase-admin|@firebase\/[^/]+|livekit-server-sdk|@livekit\/[^/]+)\//;
const LIVEKIT_OR_SOCKET =
  /^node_modules\/(@types\/)?(livekit-server-sdk|@livekit\/[^/]+|ws|socket\.io)\//;
const EXPRESS = /^node_modules\/(@types\/)?express\//;

const ATTENDANCE = 'src/modules/attendance/';
const ATTENDANCE_CONTRACTS = 'src/modules/attendance/contracts/';
const NOTIFICATIONS = 'src/modules/notifications/';
const MODULE_FILE = 'src/modules/attendance/attendance.module.ts';
const SCHEMA = 'src/modules/attendance/infrastructure/schema.ts';

/** The only cross-module surfaces attendance may reach: three modules' contracts. */
const ALLOWED_CONTRACTS = [
  'src/modules/identity/contracts/',
  'src/modules/communities/contracts/',
  'src/modules/live/contracts/',
];
const AUTHORIZATION = 'src/modules/communities/contracts/authorization.ts';
const MEMBERSHIP = 'src/modules/communities/contracts/membership.ts';
const CAPABILITY_HOLDERS = 'src/modules/communities/contracts/capability-holders.ts';
const PRESENCE = 'src/modules/live/contracts/presence.ts';
const LIVE_SESSIONS = 'src/modules/live/contracts/live-sessions.ts';

const isAttendanceCode = (source: string) =>
  source.startsWith(ATTENDANCE) && source !== MODULE_FILE;
const fromAttendance = (source: string) => source.startsWith(ATTENDANCE);

const ROOT = join(__dirname, '..', '..');
const MODULES_DIR = join(ROOT, 'src', 'modules');

/** Every module directory attendance must never reach — every one but the three it may, derived from the tree. */
const ALLOWED_MODULES = new Set(['identity', 'communities', 'live', 'attendance']);
const NEVER_REACHED = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !ALLOWED_MODULES.has(name))
  .sort();

/** Every TypeScript file under `dir` (relative to the backend). */
function typescriptFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)));
}

describe('attendance boundaries', () => {
  let output: CruiseOutput;

  beforeAll(() => {
    output = cruise();
  }, 180_000);

  const reaching = (from: (source: string) => boolean, target: (path: string) => boolean) =>
    [...reachableFrom(output, from)].filter(target);

  const otherSchemas = () =>
    output.modules
      .map((module) => module.source)
      .filter((source) => /^src\/modules\/[^/]+\/infrastructure\/schema\.ts$/.test(source))
      .filter((source) => source !== SCHEMA);

  it('was analysed — its layers are all in the graph', () => {
    const sources = output.modules.map((module) => module.source);
    for (const file of [
      'src/modules/attendance/domain/snapshot.ts',
      'src/modules/attendance/domain/ports.ts',
      'src/modules/attendance/application/record-attendance-snapshot.use-case.ts',
      'src/modules/attendance/application/list-community-snapshots.use-case.ts',
      'src/modules/attendance/application/get-attendance-snapshot.use-case.ts',
      'src/modules/attendance/application/list-snapshot-entries.use-case.ts',
      'src/modules/attendance/application/attendance-access.ts',
      'src/modules/attendance/infrastructure/drizzle-attendance-repository.ts',
      'src/modules/attendance/api/attendance.controller.ts',
      'src/modules/attendance/contracts/events.ts',
      SCHEMA,
      MODULE_FILE,
    ]) {
      expect(sources).toContain(file);
    }
    // Non-vacuous: there are other modules' schemas to stay away from.
    expect(otherSchemas().length).toBeGreaterThanOrEqual(5);
  });

  it('knows Identity, Communities and Live only through their contracts, and no other module', () => {
    const intrusions = edgesFrom(output, isAttendanceCode)
      .filter((edge) => edge.resolved.startsWith('src/modules/'))
      .filter((edge) => !edge.resolved.startsWith(ATTENDANCE))
      .filter((edge) => !ALLOWED_CONTRACTS.some((prefix) => edge.resolved.startsWith(prefix)))
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(intrusions).toEqual([]);
    // Non-vacuous: it really does reach each of the three allowed contract surfaces.
    const reached = edgesFrom(output, isAttendanceCode).map((edge) => edge.resolved);
    for (const prefix of ALLOWED_CONTRACTS) {
      expect(reached.some((path) => path.startsWith(prefix))).toBe(true);
    }
  });

  it('wires exactly Identity, Communities and Live in its module file, and no other module', () => {
    const wiring = edgesFrom(output, (source) => source === MODULE_FILE)
      .map((edge) => edge.resolved)
      .filter((path) => /^src\/modules\/[^/]+\/[^/]+\.module\.ts$/.test(path))
      .filter((path) => !path.startsWith(ATTENDANCE))
      .sort();
    expect(wiring).toEqual([
      'src/modules/communities/communities.module.ts',
      'src/modules/identity/identity.module.ts',
      'src/modules/live/live.module.ts',
    ]);
  });

  it('is reached only by the composition root and — for its event contract — by notifications', () => {
    const external = edgesFrom(output, (source) => !source.startsWith(ATTENDANCE))
      .filter((edge) => edge.resolved.startsWith(ATTENDANCE))
      // Composition roots assemble the application; they are not modules.
      .filter((edge) => !/^src\/(app\.module|main|cli\/)/.test(edge.source));

    // The one permitted external dependency: notifications, and ONLY on the
    // public contracts surface — its translator subscribes to
    // `attendance.snapshot.recorded` (P10, Q67). Any other module reaching
    // attendance at all, or notifications reaching an attendance internal,
    // appears here and fails the test.
    const unexpected = external
      .filter(
        (edge) =>
          !(
            edge.source.startsWith(NOTIFICATIONS) && edge.resolved.startsWith(ATTENDANCE_CONTRACTS)
          ),
      )
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(unexpected).toEqual([]);

    // Non-vacuous: notifications really does consume the contract, and only the
    // contracts surface — never the domain, application, infrastructure or api.
    const fromNotifications = external
      .filter((edge) => edge.source.startsWith(NOTIFICATIONS))
      .map((edge) => edge.resolved);
    expect(fromNotifications.length).toBeGreaterThan(0);
    expect(fromNotifications.every((path) => path.startsWith(ATTENDANCE_CONTRACTS))).toBe(true);
    expect(
      fromNotifications.filter((path) =>
        /^src\/modules\/attendance\/(domain|application|infrastructure|api)\//.test(path),
      ),
    ).toEqual([]);
  });

  it('checks the modules attendance must never reach — the list is derived from the tree', () => {
    // A renamed or removed module cannot quietly shrink the check below.
    expect(NEVER_REACHED).toEqual(
      expect.arrayContaining(['messaging', 'realtime', 'notifications', 'academic', 'operations']),
    );
    const sources = output.modules.map((module) => module.source);
    for (const name of NEVER_REACHED) {
      expect(sources).toContain(`src/modules/${name}/${name}.module.ts`);
    }
  });

  it.each(NEVER_REACHED)('never reaches %s — not its contracts, not its module file', (name) => {
    const target = (path: string) => path.startsWith(`src/modules/${name}/`);
    expect(
      edgesFrom(output, fromAttendance)
        .filter((edge) => target(edge.resolved))
        .map((edge) => `${edge.source} -> ${edge.resolved}`),
    ).toEqual([]);
    expect(reaching(fromAttendance, target)).toEqual([]);
  });

  it('keeps the domain pure: itself, its own contracts and the shared kernel only', () => {
    const reachable = [
      ...reachableFrom(output, (source) => source.startsWith(`${ATTENDANCE}domain/`)),
    ];
    const outside = reachable.filter(
      (target) =>
        !target.startsWith(`${ATTENDANCE}domain/`) &&
        !target.startsWith(`${ATTENDANCE}contracts/`) &&
        !target.startsWith('src/shared/'),
    );
    expect(outside).toEqual([]);
    expect(reachable.filter((target) => target.startsWith('node_modules/'))).toEqual([]);
    expect(reachable).toContain(`${ATTENDANCE}domain/snapshot.ts`);
  });

  it('keeps every layer but infrastructure free of Drizzle, pg, sockets, LiveKit and Express', () => {
    // Drizzle/pg (and every other vendor/transport) belong to infrastructure
    // alone (§7, §22). The domain, application and contracts reach none of it;
    // the api layer is the HTTP edge, so it may know Express and nothing else of
    // the kind. (The module file is composition — it wires the adapter — so it
    // is not a "layer" here.)
    const logic = (source: string) =>
      /^src\/modules\/attendance\/(domain|application|contracts)\//.test(source);
    expect(reaching(logic, (path) => VENDOR_OR_TRANSPORT.test(path))).toEqual([]);
    expect(
      reaching(
        logic,
        (path) =>
          path.startsWith(`${ATTENDANCE}api/`) ||
          path.startsWith(`${ATTENDANCE}infrastructure/`) ||
          path.startsWith('src/platform/database/') ||
          path.startsWith('src/platform/http/'),
      ),
    ).toEqual([]);
    const api = (source: string) => source.startsWith(`${ATTENDANCE}api/`);
    expect(reaching(api, (path) => VENDOR_OR_TRANSPORT.test(path) && !EXPRESS.test(path))).toEqual(
      [],
    );
    // Non-vacuous: the confinement is real — attendance's own adapter does use Drizzle and pg.
    const DRIZZLE_OR_PG = /^node_modules\/(@types\/)?(drizzle-orm|pg|pg-[^/]+)\//;
    const infraReaches = edgesFrom(output, (source) =>
      source.startsWith(`${ATTENDANCE}infrastructure/`),
    ).map((edge) => edge.resolved);
    expect(infraReaches.some((path) => DRIZZLE_OR_PG.test(path))).toBe(true);
  });

  it('never reaches LiveKit or a socket library anywhere — presence is a contract, not the media SDK', () => {
    expect(reaching(fromAttendance, (path) => LIVEKIT_OR_SOCKET.test(path))).toEqual([]);
    // Non-vacuous: attendance does reach into Live — but only its principal-less contracts.
    expect(reaching(fromAttendance, (path) => path === PRESENCE)).toEqual([PRESENCE]);
    expect(reaching(fromAttendance, (path) => path === LIVE_SESSIONS)).toEqual([LIVE_SESSIONS]);
  });

  it('uses Communities only through COMMUNITY_AUTHORIZATION — never MEMBERSHIP or CAPABILITY_HOLDERS', () => {
    const forbidden = edgesFrom(output, isAttendanceCode)
      .filter((edge) => edge.resolved === MEMBERSHIP || edge.resolved === CAPABILITY_HOLDERS)
      .map((edge) => `${edge.source} -> ${edge.resolved}`);
    expect(forbidden).toEqual([]);
    // Non-vacuous: it does reach the authorization contract (the one gate it is allowed).
    expect(reaching(isAttendanceCode, (path) => path === AUTHORIZATION)).toEqual([AUTHORIZATION]);
  });

  it('names no reserved attendance.read or attendance.manage permission (§11.2)', () => {
    const files = typescriptFiles('src/modules/attendance');
    const offenders = files.filter((file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      return text.includes('attendance.read') || text.includes('attendance.manage');
    });
    expect(offenders).toEqual([]);
    // Non-vacuous: the grep reads real content — attendance's own refusal codes are present.
    const corpus = files.map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\n');
    expect(corpus).toContain('attendance.session_not_found');
  });

  it('keeps its tables to its own adapters, and reads no other module’s tables', () => {
    const importers = edgesFrom(output, (source) => source !== SCHEMA)
      .filter((edge) => edge.resolved === SCHEMA)
      .map((edge) => edge.source);
    expect(
      importers.filter((source) => !source.startsWith(`${ATTENDANCE}infrastructure/`)),
    ).toEqual([]);
    // Non-vacuous: attendance's own Drizzle adapter does use its schema.
    expect(importers).toContain(
      'src/modules/attendance/infrastructure/drizzle-attendance-repository.ts',
    );
    expect(reaching(fromAttendance, (path) => otherSchemas().includes(path))).toEqual([]);
  });

  it('publishes a self-contained contract — itself and the shared kernel, no framework', () => {
    const contract = [
      ...reachableFrom(output, (source) => source.startsWith(`${ATTENDANCE}contracts/`)),
    ];
    expect(
      contract.filter(
        (path) => !path.startsWith(`${ATTENDANCE}contracts/`) && !path.startsWith('src/shared/'),
      ),
    ).toEqual([]);
    expect(contract).toContain('src/shared/domain-event.ts');
  });
});
