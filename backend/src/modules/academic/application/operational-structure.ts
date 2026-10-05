import structure from './operational-structure.json';

/**
 * The institution's OPERATIONAL academic structure — the one source the seed
 * reads (`seed-structure.use-case.ts`). Split from the printed profile
 * (`institution-structure.json`, which drives the app's `ProfileData` display)
 * per [ADR 0015](../../../../docs/architecture/decisions/0015-academic-structure-reconciliation.md),
 * Option A: the printed profile is never edited to carry operational data, and
 * this file never drives the profile display.
 *
 * One uniform model — `Section → Program → Halaqa` — for every section, dynamic
 * and owner-managed, with no `Level` and no hard-coded counts. Each entry's
 * provenance is recorded: `owner` (the owner's decisions, `owner-information.md`
 * S1, recorded in ADR 0015) or `profile` (the printed profile's page). Codes are
 * preserved and never reused; halaqa codes are `<section>-h<n>` by construction.
 */
/**
 * Where an entry comes from: `owner` carries the ADR `ref`; `profile` carries the
 * printed-profile `page`. Typed loosely (like the printed-profile loader) so the
 * JSON assigns directly; `validateOperationalStructure` enforces the source at runtime.
 */
export interface EntryProvenance {
  readonly source: string;
  readonly ref?: string;
  readonly page?: number;
}

export interface OperationalProgram {
  readonly code: string;
  readonly name: string;
  readonly order: number;
  /** How many halaqat to seed initially (10 = the owner's minimum; never a cap). */
  readonly halaqat: number;
}

export interface OperationalSection {
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly order: number;
  readonly provenance: EntryProvenance;
  readonly programs: readonly OperationalProgram[];
}

export interface OperationalStructure {
  readonly sections: readonly OperationalSection[];
}

/** A seeded halaqa's code: its section's code and its position — never a name. */
export function operationalHalaqaCode(sectionCode: string, position: number): string {
  return `${sectionCode}-h${position}`;
}

/** A seeded halaqa's name: its number only; the owner renames it at runtime. */
export function operationalHalaqaName(position: number): string {
  return `الحلقة ${position}`;
}

/**
 * The seed's parent / integrity check (ADR 0015): every section, program and
 * seeded halaqa code is globally unique (so a parent is never shadowed and a
 * code is never reused), every program sits under exactly one section (the
 * nesting), and every section declares its provenance. Throws on any violation;
 * returns the structure so callers can seed from a value known to be sound.
 */
export function validateOperationalStructure(input: OperationalStructure): OperationalStructure {
  const codes = new Set<string>();
  const claim = (code: string, what: string): void => {
    if (codes.has(code)) throw new Error(`operational structure: duplicate code ${code} (${what})`);
    codes.add(code);
  };
  for (const section of input.sections) {
    claim(section.code, 'section');
    if (section.provenance.source !== 'owner' && section.provenance.source !== 'profile')
      throw new Error(`operational structure: ${section.code} has no provenance`);
    for (const program of section.programs) {
      claim(program.code, `program in ${section.code}`);
      if (!Number.isInteger(program.halaqat) || program.halaqat < 0)
        throw new Error(`operational structure: ${program.code} has invalid halaqat count`);
      for (let position = 1; position <= program.halaqat; position += 1)
        claim(operationalHalaqaCode(section.code, position), `halaqa in ${program.code}`);
    }
  }
  return input;
}

export const OPERATIONAL_STRUCTURE: OperationalStructure = validateOperationalStructure(structure);
