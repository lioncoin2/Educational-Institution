import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  academicHarness,
  type AcademicHarness,
} from '../../../../test/support/academic-harness';
import { STRUCTURE_SEEDER } from './seed-structure.use-case';
import { OPERATIONAL_STRUCTURE } from './operational-structure';

const docsDir = join(__dirname, '..', '..', '..', '..', '..', 'docs');
/** The printed profile, page by page — the source for every `profile` entry. */
const EXTRACT = readFileSync(join(docsDir, 'pdf-content-extract.md'), 'utf8');
/** The owner's statements (S1) — the source for every `owner` entry (ADR 0015). */
const OWNER = readFileSync(join(docsDir, 'owner-information.md'), 'utf8');

/** The extract spaces "و" apart ("و الحركات"); compare on letters, not spacing. */
function squeeze(text: string): string {
  return text.replace(/\s+/gu, '');
}

describe('seeding the institution structure', () => {
  let h: AcademicHarness;

  beforeEach(() => {
    h = academicHarness();
  });

  function seed() {
    return h.seed.execute({ principal: STRUCTURE_SEEDER, meta: META });
  }

  it('creates the operational structure — 11 sections, 11 programs and 70 halaqat (10 each core)', async () => {
    expect(expectOk(await seed())).toEqual({
      sections: { created: 11, existing: 0 },
      programs: { created: 11, existing: 0 },
      halaqat: { created: 70, existing: 0 },
    });
    const sections = await h.readModel.catalogue();
    const counts = Object.fromEntries(
      sections.programs.map((program) => [
        program.code,
        sections.activeHalaqaCounts.get(program.id) ?? 0,
      ]),
    );
    expect(counts).toEqual({
      'dep-literacy-program': 10,
      'dep-letters-program': 10,
      'dep-tajweed-1-program': 10,
      'dep-tajweed-letters-program': 10,
      'dep-tajweed-2-program': 10,
      'dep-tajweed-3-program': 10,
      'dep-tahajji-program': 10,
      'prog-hifz-city': 0,
      'prog-nahw': 0,
      'prog-maqari': 0,
      'prog-mutun': 0,
    });
  });

  it('creates no student, no teacher, no enrollment, no progress and no description', async () => {
    expectOk(await seed());
    const catalogue = await h.readModel.catalogue();
    expect(catalogue.sections.every((s) => s.description === null)).toBe(true);
    expect(catalogue.programs.every((p) => p.description === null)).toBe(true);
    expect(h.directory.calls).toEqual([]);
    const halaqa = await h.halaqa('dep-literacy-h1');
    expect(await h.readModel.roster(halaqa.id, 'ACTIVE', { limit: 10 })).toEqual([]);
    expect(await h.readModel.teachersOf(halaqa.id, 'ACTIVE', { limit: 10 })).toEqual([]);
  });

  it('is idempotent — a second run finds everything and creates, audits and announces nothing', async () => {
    expectOk(await seed());
    const audited = h.audit.entries.length;
    const announced = h.events.published.length;
    expect(audited).toBe(92);
    expect(announced).toBe(92);
    expect(expectOk(await seed())).toEqual({
      sections: { created: 0, existing: 11 },
      programs: { created: 0, existing: 11 },
      halaqat: { created: 0, existing: 70 },
    });
    expect(h.audit.entries).toHaveLength(audited);
    expect(h.events.published).toHaveLength(announced);
  });

  it('never undoes what an administrator changed since', async () => {
    expectOk(await seed());
    const admin = h.person('admin', ['ADMIN']);
    const section = await h.repository.sectionByCode('sec-kids');
    const halaqa = await h.halaqa('dep-tajweed-1-h1');
    if (section === null) throw new Error('seed');
    expectOk(
      await h.updateSection.execute({
        principal: admin,
        sectionId: section.id,
        change: { name: 'قسم البراعم (مُعاد)' },
        meta: META,
      }),
    );
    expectOk(
      await h.halaqaStatus.execute({
        principal: admin,
        halaqaId: halaqa.id,
        status: 'INACTIVE',
        meta: META,
      }),
    );
    expectOk(await seed());
    expect((await h.repository.findSection(section.id))?.name).toBe('قسم البراعم (مُعاد)');
    expect((await h.repository.findHalaqa(halaqa.id))?.status).toBe('INACTIVE');
  });

  it('audits what it creates as the system, marking each entry’s source', async () => {
    expectOk(await seed());
    expect(h.audit.entries[0]).toMatchObject({
      actorUserId: null,
      action: 'academic.section.created',
      metadata: { code: 'dep-literacy', kind: 'PROGRESSIVE', source: 'owner' },
    });
  });

  it('is an academic administrator’s act', async () => {
    const teacher = h.person('teacher', ['TEACHER']);
    expect(expectErr(await h.seed.execute({ principal: teacher, meta: META })).kind).toBe(
      'forbidden',
    );
  });

  it('names halaqat by number only — the structure gives counts, not names', async () => {
    expectOk(await seed());
    expect((await h.halaqa('dep-tajweed-3-h10')).name).toBe('الحلقة 10');
  });

  describe('its sources of fact — split by provenance (ADR 0015)', () => {
    it('invents no name: owner names are in owner-information.md, profile names in the extract', () => {
      const extract = squeeze(EXTRACT);
      const owner = squeeze(OWNER);
      for (const section of OPERATIONAL_STRUCTURE.sections) {
        const where = section.provenance.source === 'owner' ? owner : extract;
        expect(where).toContain(squeeze(section.name));
        for (const program of section.programs) expect(where).toContain(squeeze(program.name));
      }
    });

    it('marks every section’s provenance: owner carries the ADR, profile carries its page', () => {
      for (const section of OPERATIONAL_STRUCTURE.sections) {
        if (section.provenance.source === 'owner') {
          expect(section.provenance.ref).toBe('adr-0015');
        } else {
          expect(section.provenance.source).toBe('profile');
          expect(typeof section.provenance.page).toBe('number');
        }
      }
    });

    it('gives each of the seven owner-sourced core sections ten halaqat — 70 in all', () => {
      const core = OPERATIONAL_STRUCTURE.sections.filter((s) => s.provenance.source === 'owner');
      expect(core).toHaveLength(7);
      for (const section of core) {
        expect(section.programs.map((p) => p.halaqat)).toEqual([10]);
      }
      const total = OPERATIONAL_STRUCTURE.sections
        .flatMap((s) => s.programs)
        .reduce((sum, program) => sum + program.halaqat, 0);
      expect(total).toBe(70);
    });

    it('has seven progressive sections, three special ones and the four accompanying programs', () => {
      const byKind = (kind: string) =>
        OPERATIONAL_STRUCTURE.sections.filter((s) => s.kind === kind);
      expect(byKind('PROGRESSIVE')).toHaveLength(7);
      expect(byKind('SPECIAL').map((s) => [s.name, s.provenance.page])).toEqual([
        ['قسم التهجي', 7],
        ['قسم البراعم', 8],
        ['قسم اللغات', 9],
      ]);
      expect(byKind('ACCOMPANYING').flatMap((s) => s.programs.map((p) => p.name))).toEqual([
        'مدينة الحفاظ',
        'علوم النحو',
        'المقارئ',
        'المتون',
      ]);
      // The special sections hold no programs or halaqat: no source names any.
      expect(byKind('SPECIAL').every((s) => s.programs.length === 0)).toBe(true);
    });

    it('names each core section’s own program after the section — no invented name', () => {
      for (const section of OPERATIONAL_STRUCTURE.sections.filter(
        (s) => s.kind === 'PROGRESSIVE',
      )) {
        expect(section.programs.map((p) => p.name)).toEqual([section.name]);
      }
    });
  });
});
