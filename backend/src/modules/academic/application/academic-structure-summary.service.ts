import { Inject, Injectable } from '@nestjs/common';

import type { AcademicStructureReporting, AcademicStructureSummary } from '../contracts/reporting';
import { ACADEMIC_READ_MODEL, type AcademicReadModel } from '../domain/ports';

/**
 * The academic structure summary for reporting (ADR-free: a pure read).
 *
 * It reuses the existing catalogue read — no new query, no migration — and
 * counts what the catalogue already carries: sections and programs (total and
 * ACTIVE), and the ACTIVE halaqat per program (summed). It states no rule and
 * loads no person; authorization is the caller's (reporting re-checks).
 */
@Injectable()
export class AcademicStructureSummaryService implements AcademicStructureReporting {
  constructor(@Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel) {}

  async structureSummary(): Promise<AcademicStructureSummary> {
    const catalogue = await this.readModel.catalogue();
    const sectionsActive = catalogue.sections.filter((s) => s.status === 'ACTIVE').length;
    const programsActive = catalogue.programs.filter((p) => p.status === 'ACTIVE').length;
    let activeHalaqat = 0;
    for (const count of catalogue.activeHalaqaCounts.values()) activeHalaqat += count;
    return {
      sections: { total: catalogue.sections.length, active: sectionsActive },
      programs: { total: catalogue.programs.length, active: programsActive },
      activeHalaqat,
    };
  }
}
