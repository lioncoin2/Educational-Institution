import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { err, failure, ok, type Principal, type Result } from '../../../shared';
import {
  type CommunityAuthorization,
  type CommunityPermit,
} from '../../communities/contracts/authorization';
import { COMMUNITY_RESOURCE, type CommunityAct } from '../../communities/contracts/capabilities';
import { AttendanceAccess, permitOf } from './attendance-access';
import { AttendanceRefusals } from './attendance-settings';

const COMMUNITY = 'c-1';
const HOST = 'host-1';

type Answer = Result<CommunityPermit> | 'reject';

/**
 * A fake Communities authorizer: it answers each act from a table (a default
 * for the rest), records the acts asked in order, and rejects to model a store
 * outage. AttendanceAccess calls only `authorize`.
 */
class FakeCommunities implements CommunityAuthorization {
  readonly asked: CommunityAct[] = [];

  constructor(
    private readonly table: Partial<Record<CommunityAct, Answer>>,
    private readonly fallback: Answer = CAPABILITY_REQUIRED,
  ) {}

  authorize(_p: Principal, _c: string, act: CommunityAct): Promise<Result<CommunityPermit>> {
    this.asked.push(act);
    const answer = this.table[act] ?? this.fallback;
    if (answer === 'reject') return Promise.reject(new Error('store down'));
    return Promise.resolve(answer);
  }

  authorizeEach(): Promise<ReadonlyMap<string, Result<CommunityPermit>>> {
    throw new Error('AttendanceAccess never calls authorizeEach');
  }

  permittedAmong(): Promise<readonly string[]> {
    throw new Error('AttendanceAccess never calls permittedAmong');
  }
}

function permit(
  act: CommunityAct,
  basis: CommunityPermit['basis'],
  hasStint = true,
): Result<CommunityPermit> {
  return ok({
    principalUserId: 'u-1',
    communityId: COMMUNITY,
    scope: COMMUNITY_RESOURCE,
    act,
    basis,
    membership: hasStint ? { membershipId: 'm-1', joinedAt: new Date(0), version: 1 } : null,
    grantId: basis === 'grant' ? 'g-1' : null,
    ceiling: [],
  });
}

const COMMUNITY_NOT_FOUND: Result<CommunityPermit> = err(
  failure('not_found', 'communities.community_not_found', 'No such community.'),
);
const PERMISSION_DENIED: Result<CommunityPermit> = err(
  failure('forbidden', 'identity.permission_denied', 'You may not perform this action.'),
);
const CAPABILITY_REQUIRED: Result<CommunityPermit> = err(
  failure('forbidden', 'communities.capability_required', 'You do not hold this capability.'),
);
const LOCKED: Result<CommunityPermit> = err(
  failure('precondition_failed', 'communities.community_locked', 'This community is locked.'),
);

function access(
  table: Partial<Record<CommunityAct, Answer>>,
  fallback?: Answer,
): {
  gate: AttendanceAccess;
  fake: FakeCommunities;
} {
  const fake = new FakeCommunities(table, fallback);
  return { gate: new AttendanceAccess(fake), fake };
}

const principal = (userId: string): Principal => ({ userId, roles: [], permissions: new Set() });

describe('AttendanceAccess — record (attendance.md §11.3)', () => {
  it('permits on community.attendance.record, and returns the permit for the audit entry', async () => {
    const { gate, fake } = access({
      'community.attendance.record': permit('community.attendance.record', 'grant'),
    });
    const answer = await gate.record(principal('u-1'), {
      communityId: COMMUNITY,
      hostUserId: HOST,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error('expected a permit');
    expect(answer.value.act).toBe('community.attendance.record');
    expect(permitOf(answer.value)).toEqual({
      act: 'community.attendance.record',
      basis: 'grant',
      membershipId: 'm-1',
      grantId: 'g-1',
    });
    // The first act permitted, so nothing else was asked.
    expect(fake.asked).toEqual(['community.attendance.record']);
  });

  it('falls back to community.live.moderate when the record act is forbidden', async () => {
    const { gate, fake } = access({
      'community.attendance.record': CAPABILITY_REQUIRED,
      'community.live.moderate': permit('community.live.moderate', 'owner'),
    });
    const answer = await gate.record(principal('u-2'), {
      communityId: COMMUNITY,
      hostUserId: HOST,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error('expected a permit');
    expect(answer.value.act).toBe('community.live.moderate');
    expect(fake.asked).toEqual(['community.attendance.record', 'community.live.moderate']);
  });

  it('falls back to community.live.host — but only for the session host', async () => {
    const { gate, fake } = access({
      'community.attendance.record': CAPABILITY_REQUIRED,
      'community.live.moderate': CAPABILITY_REQUIRED,
      'community.live.host': permit('community.live.host', 'owner'),
    });
    const asHost = await gate.record(principal(HOST), { communityId: COMMUNITY, hostUserId: HOST });
    expect(asHost.ok).toBe(true);
    if (!asHost.ok) throw new Error('expected a permit');
    expect(asHost.value.act).toBe('community.live.host');
    expect(fake.asked).toEqual([
      'community.attendance.record',
      'community.live.moderate',
      'community.live.host',
    ]);
  });

  it('never asks community.live.host for a non-host — and refuses with 403 not_allowed', async () => {
    const { gate, fake } = access(
      {
        'community.live.host': permit('community.live.host', 'owner'), // would permit, but must not be asked
      },
      CAPABILITY_REQUIRED,
    );
    const answer = await gate.record(principal('not-the-host'), {
      communityId: COMMUNITY,
      hostUserId: HOST,
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.error).toBe(AttendanceRefusals.notAllowed);
    expect(fake.asked).toEqual(['community.attendance.record', 'community.live.moderate']);
    expect(fake.asked).not.toContain('community.live.host');
  });

  it('stops at not_found and never tries the later acts — mapped to 404 session_not_found', async () => {
    const { gate, fake } = access({ 'community.attendance.record': COMMUNITY_NOT_FOUND });
    const answer = await gate.record(principal(HOST), { communityId: COMMUNITY, hostUserId: HOST });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.error).toBe(AttendanceRefusals.sessionNotFound);
    expect(fake.asked).toEqual(['community.attendance.record']);
  });

  it('maps no-ceiling (identity.permission_denied) to 404 session_not_found, never 403', async () => {
    const { gate } = access({}, PERMISSION_DENIED);
    const answer = await gate.record(principal('u-9'), {
      communityId: COMMUNITY,
      hostUserId: HOST,
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.error).toBe(AttendanceRefusals.sessionNotFound);
  });

  it('maps a lock to 412 community_not_open', async () => {
    const { gate } = access({ 'community.attendance.record': LOCKED });
    const answer = await gate.record(principal(HOST), { communityId: COMMUNITY, hostUserId: HOST });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.error).toBe(AttendanceRefusals.communityNotOpen);
  });

  it('fails closed with 503 unavailable when Communities cannot answer', async () => {
    const { gate } = access({ 'community.attendance.record': 'reject' });
    const answer = await gate.record(principal(HOST), { communityId: COMMUNITY, hostUserId: HOST });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.error.kind).toBe('unavailable');
  });
});

describe('AttendanceAccess — one snapshot (attendance.md §11.3)', () => {
  it('permits on community.attendance.view', async () => {
    const { gate, fake } = access({
      'community.attendance.view': permit('community.attendance.view', 'grant'),
    });
    const answer = await gate.snapshotView(principal('u-1'), {
      communityId: COMMUNITY,
      recorderOrHost: false,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error('expected a permit');
    expect(answer.value.act).toBe('community.attendance.view');
    expect(fake.asked).toEqual(['community.attendance.view']);
  });

  it('falls back to community.view on the membership basis for a host or recorder', async () => {
    const { gate, fake } = access({
      'community.attendance.view': CAPABILITY_REQUIRED,
      'community.view': permit('community.view', 'membership'),
    });
    const answer = await gate.snapshotView(principal('u-2'), {
      communityId: COMMUNITY,
      recorderOrHost: true,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) throw new Error('expected a permit');
    expect(answer.value.act).toBe('community.view');
    expect(answer.value.basis).toBe('membership');
    expect(fake.asked).toEqual(['community.attendance.view', 'community.view']);
  });

  it('rejects an oversight-basis community.view — a non-member sees nothing (§11.2)', async () => {
    const { gate } = access({
      'community.attendance.view': CAPABILITY_REQUIRED,
      'community.view': permit('community.view', 'oversight', false),
    });
    const answer = await gate.snapshotView(principal('overseer'), {
      communityId: COMMUNITY,
      recorderOrHost: true,
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.error).toBe(AttendanceRefusals.snapshotNotFound);
  });

  it('does not fall back for someone who neither hosted nor recorded — 404 snapshot_not_found', async () => {
    const { gate, fake } = access({ 'community.attendance.view': CAPABILITY_REQUIRED });
    const answer = await gate.snapshotView(principal('u-3'), {
      communityId: COMMUNITY,
      recorderOrHost: false,
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected a refusal');
    // A member without the act is answered 404 on one snapshot, never 403.
    expect(answer.error).toBe(AttendanceRefusals.snapshotNotFound);
    expect(fake.asked).toEqual(['community.attendance.view']);
    expect(fake.asked).not.toContain('community.view');
  });

  it('maps a lock to 412 and an outage to 503', async () => {
    const locked = access({ 'community.attendance.view': LOCKED });
    const lockedAnswer = await locked.gate.snapshotView(principal('u-4'), {
      communityId: COMMUNITY,
      recorderOrHost: true,
    });
    expect(lockedAnswer.ok).toBe(false);
    if (lockedAnswer.ok) throw new Error('expected a refusal');
    expect(lockedAnswer.error).toBe(AttendanceRefusals.communityNotOpen);

    const down = access({ 'community.attendance.view': 'reject' });
    const downAnswer = await down.gate.snapshotView(principal('u-4'), {
      communityId: COMMUNITY,
      recorderOrHost: true,
    });
    expect(downAnswer.ok).toBe(false);
    if (downAnswer.ok) throw new Error('expected a refusal');
    expect(downAnswer.error.kind).toBe('unavailable');
  });
});

describe('AttendanceAccess — the community list (attendance.md §11.3)', () => {
  it('permits on community.attendance.view', async () => {
    const { gate } = access({
      'community.attendance.view': permit('community.attendance.view', 'owner'),
    });
    const answer = await gate.listView(principal('u-1'), {
      communityId: COMMUNITY,
      hostedOrRecorded: false,
    });
    expect(answer.ok).toBe(true);
  });

  it('answers a member without the act 403 not_allowed (the list path, unlike one snapshot)', async () => {
    const { gate, fake } = access({ 'community.attendance.view': CAPABILITY_REQUIRED });
    const answer = await gate.listView(principal('u-2'), {
      communityId: COMMUNITY,
      hostedOrRecorded: false,
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.error).toBe(AttendanceRefusals.notAllowed);
    expect(fake.asked).not.toContain('community.view');
  });

  it('falls back to community.view for someone who hosted or recorded in a session', async () => {
    const { gate } = access({
      'community.attendance.view': CAPABILITY_REQUIRED,
      'community.view': permit('community.view', 'membership'),
    });
    const answer = await gate.listView(principal('u-3'), {
      communityId: COMMUNITY,
      hostedOrRecorded: true,
    });
    expect(answer.ok).toBe(true);
  });

  it('maps an unknown community to 404 community_not_found', async () => {
    const { gate } = access({ 'community.attendance.view': COMMUNITY_NOT_FOUND });
    const answer = await gate.listView(principal('u-4'), {
      communityId: COMMUNITY,
      hostedOrRecorded: true,
    });
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('expected a refusal');
    expect(answer.error).toBe(AttendanceRefusals.communityNotFound);
  });
});

describe('AttendanceAccess — Option B and the firewall', () => {
  it('authorizes on community standing alone — no academic relationship is consulted (Option B)', async () => {
    const { gate, fake } = access({
      'community.attendance.record': permit('community.attendance.record', 'owner'),
    });
    const answer = await gate.record(principal('u-1'), {
      communityId: COMMUNITY,
      hostUserId: HOST,
    });
    expect(answer.ok).toBe(true);
    // Only community acts are ever asked: the absence of any academic link does
    // not block authorization, and attendance never reaches for one.
    for (const act of fake.asked) expect(act.startsWith('community.')).toBe(true);
  });

  it('refuses when no community standing permits — there is no bypass', async () => {
    // Every act forbidden (a member without any of them), and no fallback basis.
    const { gate } = access({}, CAPABILITY_REQUIRED);
    const record = await gate.record(principal('u-1'), {
      communityId: COMMUNITY,
      hostUserId: HOST,
    });
    const view = await gate.snapshotView(principal('u-1'), {
      communityId: COMMUNITY,
      recorderOrHost: true,
    });
    const list = await gate.listView(principal('u-1'), {
      communityId: COMMUNITY,
      hostedOrRecorded: true,
    });
    expect(record.ok).toBe(false);
    expect(view.ok).toBe(false);
    expect(list.ok).toBe(false);
  });

  it('never imports academic, and never names an attendance.* identity permission (§4, §11.2)', () => {
    const forbiddenPerms = ['read', 'manage', 'oversee'].map((suffix) => `attendance.${suffix}`);
    const academicImport = /\bfrom\s+['"][^'"]*academic/u;
    const files = attendanceSourceFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect({ file, importsAcademic: academicImport.test(text) }).toEqual({
        file,
        importsAcademic: false,
      });
      for (const perm of forbiddenPerms) {
        expect({ file, perm, present: text.includes(perm) }).toEqual({
          file,
          perm,
          present: false,
        });
      }
    }
  });
});

/** Every `.ts` file the attendance module owns, so the firewall is checked on all of them. */
function attendanceSourceFiles(): string[] {
  const root = join(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);
  return files;
}
