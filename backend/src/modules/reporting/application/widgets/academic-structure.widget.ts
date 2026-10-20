import { Inject, Injectable } from '@nestjs/common';

import {
  ACADEMIC_STRUCTURE_SUMMARY,
  type AcademicStructureReporting,
} from '../../../academic/contracts/reporting';
import { Permissions } from '../../../identity/contracts/permissions';
import type { WidgetData, WidgetDescriptor, WidgetProvider } from '../../contracts';

/**
 * Owner Command Center — academic structure summary. FACTS only: how many
 * sections, programs and halaqat are ACTIVE now (Section → Program → Halaqa).
 * Read through academic's public summary contract; no roster, no person, no
 * rule. A viewer sees this widget only if they already hold `academic.read`.
 */
@Injectable()
export class AcademicStructureWidget implements WidgetProvider {
  constructor(
    @Inject(ACADEMIC_STRUCTURE_SUMMARY) private readonly academic: AcademicStructureReporting,
  ) {}

  readonly descriptor: WidgetDescriptor = {
    id: 'academic.structure',
    category: 'today',
    title: 'الهيكل الأكاديمي',
    requiredPermission: Permissions.academic.read,
  };

  async resolve(): Promise<WidgetData> {
    const summary = await this.academic.structureSummary();
    return {
      widgetId: this.descriptor.id,
      payload: {
        metrics: [
          { key: 'sections_active', label: 'الأقسام المُفعّلة', value: summary.sections.active },
          { key: 'programs_active', label: 'البرامج المُفعّلة', value: summary.programs.active },
          { key: 'halaqat_active', label: 'الحلقات المُفعّلة', value: summary.activeHalaqat },
        ],
      },
    };
  }
}
