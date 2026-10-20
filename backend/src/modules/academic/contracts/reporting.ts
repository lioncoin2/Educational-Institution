/**
 * Academic's read-only summary for the Owner Command Center (reporting).
 *
 * Facts only — a count of the academic structure, no roster, no person, no
 * rule. It exists so `reporting` can surface an institution-wide figure through
 * academic's public surface rather than its tables. The viewer is authorized by
 * the caller (reporting re-checks `academic.read`); this contract states nothing
 * about who may see it.
 */

/** DI token for {@link AcademicStructureReporting}. */
export const ACADEMIC_STRUCTURE_SUMMARY = Symbol('ACADEMIC_STRUCTURE_SUMMARY');

/** One kind of structure node: how many exist, and how many are ACTIVE. */
export interface StructureCount {
  readonly total: number;
  readonly active: number;
}

/**
 * An institution-wide count of the academic structure. `activeHalaqat` is the
 * count of ACTIVE halaqat — the operational figure academic reports; inactive
 * halaqat are not enumerated at this surface (the catalogue carries only the
 * active count per program).
 */
export interface AcademicStructureSummary {
  readonly sections: StructureCount;
  readonly programs: StructureCount;
  readonly activeHalaqat: number;
}

export interface AcademicStructureReporting {
  /** A pure read over the existing catalogue; loads no roster and no person. */
  structureSummary(): Promise<AcademicStructureSummary>;
}
