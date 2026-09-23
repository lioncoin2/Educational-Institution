import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectErr, expectOk } from '../../../../test/support/identity-harness';
import {
  META,
  academicHarness,
  type AcademicHarness,
} from '../../../../test/support/academic-harness';
import { STRUCTURE_SEEDER } from './seed-structure.use-case';
import { INSTITUTION_STRUCTURE } from './institution-structure';

const EXTRACT = readFileSync(
  join(__dirname, '..', '..', '..', '..', '..', 'docs', 'pdf-content-extract.md'),
  'utf8',
);

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

  it('creates the profile’s sections, programs and 45 halaqat — 5, 10, 10, 10, 10', async () => {
    expect(expectOk(await seed())).toEqual({
      sections: { created: 9, existing: 0 },
      programs: { created: 9, existing: 0 },
      halaqat: { created: 45, existing: 0 },
    });
    const sections = await h.readModel.catalogue();
    const counts = Object.fromEntries(
      sections.programs.map((program) => [
        program.code,
        sections.activeHalaqaCounts.get(program.id) ?? 0,
      ]),
    );
    expect(counts).toEqual({
      'dep-literacy-program': 5,
      'dep-letters-program': 10,
      'dep-tajweed-1-program': 10,
      'dep-tajweed-2-program': 10,
      'dep-tajweed-3-program': 10,
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
    expect(audited).toBe(63);
    expect(announced).toBe(63);
    expect(expectOk(await seed())).toEqual({
      sections: { created: 0, existing: 9 },
      programs: { created: 0, existing: 9 },
      halaqat: { created: 0, existing: 45 },
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

  it('audits what it creates as the system, from the institution profile', async () => {
    expectOk(await seed());
    expect(h.audit.entries[0]).toMatchObject({
      actorUserId: null,
      action: 'academic.section.created',
      metadata: { code: 'dep-literacy', kind: 'PROGRESSIVE', source: 'institution-profile' },
    });
  });

  it('is an academic administrator’s act', async () => {
    const teacher = h.person('teacher', ['TEACHER']);
    expect(expectErr(await h.seed.execute({ principal: teacher, meta: META })).kind).toBe(
      'forbidden',
    );
  });

  it('names halaqat by number only — the profile gives counts, not names', async () => {
    expectOk(await seed());
    expect((await h.halaqa('dep-tajweed-3-h10')).name).toBe('الحلقة 10');
  });

  describe('its one source of facts', () => {
    it('states nothing the institution profile does not: every name is in the page-by-page extract', () => {
      const extract = squeeze(EXTRACT);
      for (const section of INSTITUTION_STRUCTURE.sections) {
        expect(extract).toContain(squeeze(section.name));
        for (const program of section.programs) expect(extract).toContain(squeeze(program.name));
      }
    });

    it('takes each progressive section’s halaqat count from page 6', () => {
      for (const section of INSTITUTION_STRUCTURE.sections.filter(
        (s) => s.kind === 'PROGRESSIVE',
      )) {
        const [program] = section.programs;
        expect(section.sourcePage).toBe(6);
        expect(EXTRACT).toContain(`| ${section.name} | ${program?.halaqat} حلقات |`);
      }
      const total = INSTITUTION_STRUCTURE.sections
        .flatMap((s) => s.programs)
        .reduce((sum, program) => sum + program.halaqat, 0);
      expect(total).toBe(45);
    });

    it('has five progressive sections, three special ones and the four accompanying programs', () => {
      const byKind = (kind: string) =>
        INSTITUTION_STRUCTURE.sections.filter((s) => s.kind === kind);
      expect(byKind('PROGRESSIVE')).toHaveLength(5);
      expect(byKind('SPECIAL').map((s) => [s.name, s.sourcePage])).toEqual([
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
      // The special sections hold no programs or halaqat: the profile names none.
      expect(byKind('SPECIAL').every((s) => s.programs.length === 0)).toBe(true);
    });

    it('names each progressive section’s own program after the section — no invented name', () => {
      for (const section of INSTITUTION_STRUCTURE.sections.filter(
        (s) => s.kind === 'PROGRESSIVE',
      )) {
        expect(section.programs.map((p) => p.name)).toEqual([section.name]);
      }
    });
  });
});
