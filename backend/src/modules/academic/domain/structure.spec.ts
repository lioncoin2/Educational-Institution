import { asId } from '../../../shared/identifier';
import {
  applyChange,
  applyHalaqaChange,
  createHalaqa,
  createProgram,
  createSection,
  openForEnrollment,
  stampedAt,
  type HalaqaId,
  type ProgramId,
  type Section,
  type SectionId,
} from './structure';
import { normalizeCode, normalizeDescription, normalizeName, validateOrder } from './text';

const AT = new Date('2026-09-01T08:00:00.000Z');
const LATER = new Date('2026-09-02T08:00:00.000Z');

function section(overrides: Partial<Parameters<typeof createSection>[0]> = {}): Section {
  const result = createSection({
    id: asId<'AcademicSection'>('section-1'),
    code: 'dep-literacy',
    name: 'قسم محو الأمية',
    kind: 'PROGRESSIVE',
    order: 1,
    at: AT,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function codeOf(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe('academic text rules', () => {
  it('normalizes codes to lower case and holds them to letters, digits and single hyphens', () => {
    expect(normalizeCode('  Dep-Literacy ')).toEqual({ ok: true, value: 'dep-literacy' });
    expect(normalizeCode('tajweed-2')).toEqual({ ok: true, value: 'tajweed-2' });
    for (const bad of [
      'a',
      'dep literacy',
      'dep--literacy',
      '-dep',
      'dep-',
      'dep_1',
      'قسم',
      'x'.repeat(65),
    ]) {
      expect(codeOf(normalizeCode(bad))).toBe('academic.code_invalid');
    }
  });

  it('never derives a code from a name — a name is not a valid code', () => {
    expect(codeOf(normalizeCode('قسم محو الأمية'))).toBe('academic.code_invalid');
  });

  it('trims names and collapses their inner whitespace', () => {
    expect(normalizeName('  قسم   التهجي ')).toEqual({ ok: true, value: 'قسم التهجي' });
    expect(codeOf(normalizeName('   '))).toBe('academic.name_invalid');
    expect(codeOf(normalizeName('ق'.repeat(121)))).toBe('academic.name_invalid');
    expect(normalizeName('ق'.repeat(120)).ok).toBe(true);
  });

  it('refuses control and direction characters in names rather than silently stripping them', () => {
    for (const bad of [
      'قسم\u202eالتهجي',
      'قسم\u2066x\u2069',
      'line\nbreak',
      'tab\there',
      'nul\u0000',
    ]) {
      expect(codeOf(normalizeName(bad))).toBe('academic.name_invalid');
    }
  });

  it('keeps line breaks in descriptions, treats blank as none, and bounds the length', () => {
    expect(normalizeDescription(' سطر\r\nثانٍ ')).toEqual({ ok: true, value: 'سطر\nثانٍ' });
    expect(normalizeDescription('   ')).toEqual({ ok: true, value: null });
    expect(normalizeDescription(null)).toEqual({ ok: true, value: null });
    expect(normalizeDescription(undefined)).toEqual({ ok: true, value: null });
    expect(codeOf(normalizeDescription('x'.repeat(2001)))).toBe('academic.description_invalid');
    expect(codeOf(normalizeDescription('a\u202eb'))).toBe('academic.description_invalid');
  });

  it('accepts whole-number positions from 1', () => {
    expect(validateOrder(1).ok).toBe(true);
    expect(validateOrder(10_000).ok).toBe(true);
    for (const bad of [0, -1, 1.5, 10_001, Number.NaN]) {
      expect(codeOf(validateOrder(bad))).toBe('academic.order_invalid');
    }
  });
});

describe('sections, programs and halaqat', () => {
  it('creates a section ACTIVE, with its kind and normalized fields', () => {
    expect(section({ code: ' DEP-Literacy ', name: ' قسم  محو الأمية ' })).toEqual({
      id: 'section-1',
      code: 'dep-literacy',
      name: 'قسم محو الأمية',
      kind: 'PROGRESSIVE',
      order: 1,
      description: null,
      status: 'ACTIVE',
      createdAt: AT,
      updatedAt: AT,
    });
  });

  it('refuses a section kind the profile does not describe', () => {
    const result = createSection({
      id: asId<'AcademicSection'>('s'),
      code: 'x-section',
      name: 'قسم',
      kind: 'DEPARTMENT',
      order: 1,
      at: AT,
    });
    expect(codeOf(result)).toBe('academic.kind_invalid');
  });

  it('creates a program in exactly one section, and a halaqa in exactly one program', () => {
    const program = createProgram({
      id: asId<'AcademicProgram'>('p1'),
      sectionId: 'section-1' as SectionId,
      code: 'prog-mutun',
      name: 'المتون',
      order: 4,
      at: AT,
    });
    expect(program).toMatchObject({
      ok: true,
      value: { sectionId: 'section-1', status: 'ACTIVE' },
    });
    const halaqa = createHalaqa({
      id: asId<'AcademicHalaqa'>('h1'),
      programId: 'p1' as ProgramId,
      code: 'dep-literacy-h1',
      name: 'الحلقة 1',
      order: 1,
      at: AT,
    });
    expect(halaqa).toMatchObject({ ok: true, value: { programId: 'p1', status: 'ACTIVE' } });
  });

  it('applies only the fields that change, reports them by name, and stamps the change', () => {
    const original = section();
    const applied = applyChange(original, { name: 'قسم محو الأمية', order: 2 }, LATER);
    expect(applied).toEqual({
      ok: true,
      value: { entity: { ...original, order: 2, updatedAt: LATER }, changed: ['order'] },
    });
  });

  it('treats a change that alters nothing as no change at all', () => {
    const original = section();
    const applied = applyChange(original, { name: 'قسم محو الأمية' }, LATER);
    expect(applied).toEqual({ ok: true, value: { entity: original, changed: [] } });
  });

  it('clears a description with null, and refuses an empty change', () => {
    const described = section({ description: 'وصف' });
    expect(applyChange(described, { description: null }, LATER)).toMatchObject({
      ok: true,
      value: { entity: { description: null }, changed: ['description'] },
    });
    expect(codeOf(applyChange(described, {}, LATER))).toBe('academic.change_empty');
  });

  it('edits a halaqa by name and order only', () => {
    const halaqa = createHalaqa({
      id: asId<'AcademicHalaqa'>('h1'),
      programId: 'p1' as ProgramId,
      code: 'dep-literacy-h1',
      name: 'الحلقة 1',
      order: 1,
      at: AT,
    });
    if (!halaqa.ok) throw new Error('fixture');
    expect(applyHalaqaChange(halaqa.value, { name: 'حلقة الفجر' }, LATER)).toMatchObject({
      ok: true,
      value: { entity: { name: 'حلقة الفجر', code: 'dep-literacy-h1' }, changed: ['name'] },
    });
    expect(codeOf(applyHalaqaChange(halaqa.value, {}, LATER))).toBe('academic.change_empty');
  });

  it('never moves updatedAt backwards when another instance runs a slower clock', () => {
    const original = section();
    const earlier = new Date(AT.getTime() - 60_000);
    expect(stampedAt(original, earlier)).toEqual(AT);
    expect(applyChange(original, { order: 3 }, earlier)).toMatchObject({
      ok: true,
      value: { entity: { updatedAt: AT } },
    });
  });

  describe('open for enrollment', () => {
    const open = { status: 'ACTIVE' as const };
    const closed = { status: 'INACTIVE' as const };

    it('only when the section, the program and the halaqa are all ACTIVE', () => {
      expect(openForEnrollment({ section: open, program: open, halaqa: open }).ok).toBe(true);
    });

    it('names the outermost reason first', () => {
      expect(codeOf(openForEnrollment({ section: closed, program: closed, halaqa: closed }))).toBe(
        'academic.section_inactive',
      );
      expect(codeOf(openForEnrollment({ section: open, program: closed, halaqa: closed }))).toBe(
        'academic.program_inactive',
      );
      expect(codeOf(openForEnrollment({ section: open, program: open, halaqa: closed }))).toBe(
        'academic.halaqa_inactive',
      );
    });
  });

  it('keeps halaqa ids distinct from program ids at the type level', () => {
    const halaqaId: HalaqaId = asId<'AcademicHalaqa'>('h');
    expect(halaqaId).toBe('h');
  });
});
