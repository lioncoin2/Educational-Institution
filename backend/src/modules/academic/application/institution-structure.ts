import structure from './institution-structure.json';

/**
 * The institution's academic structure as its printed profile states it — read
 * from `institution-structure.json`, the one copy of those facts in the
 * codebase. The Flutter app's `ProfileData` is held to the same file by a test,
 * so the two cannot drift apart unnoticed.
 *
 * Provisional: the owner's later description (seven core sections, 10 basic
 * halaqat each, مدينة التهجي) differs and is not yet mapped onto it — see
 * `docs/owner-information.md` and open questions Q35–Q39. Nothing here encodes
 * the owner's statements.
 */
export interface ProfileProgram {
  readonly code: string;
  readonly name: string;
  readonly order: number;
  /** How many halaqat the profile states (page 6); 0 where it states none. */
  readonly halaqat: number;
}

export interface ProfileSection {
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly order: number;
  /** The profile page it is taken from. */
  readonly sourcePage: number;
  readonly programs: readonly ProfileProgram[];
}

export interface InstitutionStructure {
  readonly source: string;
  readonly sections: readonly ProfileSection[];
}

export const INSTITUTION_STRUCTURE: InstitutionStructure = structure;

/**
 * A seeded halaqa's code: its section's code and its position — never derived
 * from a name. `dep-literacy-h3` is the third halaqa of قسم محو الأمية.
 */
export function seededHalaqaCode(sectionCode: string, position: number): string {
  return `${sectionCode}-h${position}`;
}

/**
 * A seeded halaqa's name. The profile gives the number of halaqat, not their
 * names, so a seeded halaqa is named by its number only; the institution
 * renames it when it has a name.
 */
export function seededHalaqaName(position: number): string {
  return `الحلقة ${position}`;
}
