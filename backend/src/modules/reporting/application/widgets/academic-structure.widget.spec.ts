import type { AcademicStructureReporting } from '../../../academic/contracts/reporting';
import { AcademicStructureWidget } from './academic-structure.widget';

function reportingWith(summary: {
  sections: { total: number; active: number };
  programs: { total: number; active: number };
  activeHalaqat: number;
}): AcademicStructureReporting {
  return { structureSummary: async () => summary };
}

describe('AcademicStructureWidget', () => {
  it('describes itself for academic.read, in the "today" category', () => {
    const widget = new AcademicStructureWidget(
      reportingWith({
        sections: { total: 0, active: 0 },
        programs: { total: 0, active: 0 },
        activeHalaqat: 0,
      }),
    );
    expect(widget.descriptor).toMatchObject({
      id: 'academic.structure',
      category: 'today',
      requiredPermission: 'academic.read',
    });
  });

  it('maps the active structure counts to metrics', async () => {
    const widget = new AcademicStructureWidget(
      reportingWith({
        sections: { total: 7, active: 5 },
        programs: { total: 10, active: 8 },
        activeHalaqat: 42,
      }),
    );

    const data = await widget.resolve();

    expect(data.widgetId).toBe('academic.structure');
    expect(data.payload).toEqual({
      metrics: [
        { key: 'sections_active', label: 'الأقسام المُفعّلة', value: 5 },
        { key: 'programs_active', label: 'البرامج المُفعّلة', value: 8 },
        { key: 'halaqat_active', label: 'الحلقات المُفعّلة', value: 42 },
      ],
    });
  });
});
