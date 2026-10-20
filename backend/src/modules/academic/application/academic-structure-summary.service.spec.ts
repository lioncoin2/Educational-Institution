import type { Catalogue } from '../domain/ports';
import type { AcademicReadModel } from '../domain/ports';
import { AcademicStructureSummaryService } from './academic-structure-summary.service';

/** A read model that answers one fixed catalogue; nothing else is called. */
function readModelWith(catalogue: Catalogue): AcademicReadModel {
  return {
    catalogue: async () => catalogue,
    // The summary never touches any other read.
  } as unknown as AcademicReadModel;
}

function section(id: string, status: 'ACTIVE' | 'INACTIVE') {
  return { id, code: id, kind: 'CORE', title: id, order: 1, status } as never;
}
function program(id: string, status: 'ACTIVE' | 'INACTIVE') {
  return { id, sectionId: 's', code: id, title: id, order: 1, status } as never;
}

describe('AcademicStructureSummaryService', () => {
  it('counts sections and programs (total and active) and sums active halaqat', async () => {
    const catalogue: Catalogue = {
      sections: [section('s1', 'ACTIVE'), section('s2', 'ACTIVE'), section('s3', 'INACTIVE')],
      programs: [program('p1', 'ACTIVE'), program('p2', 'INACTIVE')],
      activeHalaqaCounts: new Map([
        ['p1', 4],
        ['p2', 0],
        ['p3', 2],
      ]),
    };
    const service = new AcademicStructureSummaryService(readModelWith(catalogue));

    const summary = await service.structureSummary();

    expect(summary.sections).toEqual({ total: 3, active: 2 });
    expect(summary.programs).toEqual({ total: 2, active: 1 });
    expect(summary.activeHalaqat).toBe(6); // 4 + 0 + 2
  });

  it('answers zeros for an empty institution, never throws', async () => {
    const service = new AcademicStructureSummaryService(
      readModelWith({ sections: [], programs: [], activeHalaqaCounts: new Map() }),
    );
    const summary = await service.structureSummary();
    expect(summary).toEqual({
      sections: { total: 0, active: 0 },
      programs: { total: 0, active: 0 },
      activeHalaqat: 0,
    });
  });
});
