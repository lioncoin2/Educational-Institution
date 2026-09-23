import { Inject, Injectable } from '@nestjs/common';

import { err, failure, ok, type Principal, type Result } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import {
  ACADEMIC_READ_MODEL,
  ACADEMIC_REPOSITORY,
  type AcademicReadModel,
  type AcademicRepository,
  type Catalogue,
} from '../domain/ports';
import { AcademicAccess, HALAQA_NOT_FOUND } from './academic-access';
import { AcademicResources } from './academic-settings';
import {
  halaqaView,
  placementView,
  programView,
  sectionView,
  type CatalogueSectionView,
  type HalaqaDetailView,
  type ProgramDetailView,
} from './views';

export const SECTION_NOT_FOUND = failure(
  'not_found',
  'academic.section_not_found',
  'No such section.',
);

export const PROGRAM_NOT_FOUND = failure(
  'not_found',
  'academic.program_not_found',
  'No such program.',
);

/** Sections in order, each with its programs in order. */
function tree(catalogue: Catalogue): CatalogueSectionView[] {
  return catalogue.sections.map((section) => ({
    ...sectionView(section),
    programs: catalogue.programs
      .filter((program) => program.sectionId === section.id)
      .map((program) => programView(program, catalogue.activeHalaqaCounts.get(program.id) ?? 0)),
  }));
}

/**
 * The whole catalogue: every section, its programs, and how many of each
 * program's halaqat are active. Structure is institution-wide information —
 * every role may read it; who is IN a halaqa is not part of it.
 *
 * Bounded by invariant (AcademicLimits), so it is one bounded read, not a
 * paged one. Inactive entries are included and marked: history refers to
 * them, and a client decides what to show.
 */
@Injectable()
export class GetCatalogueUseCase {
  constructor(
    private readonly access: AcademicAccess,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
  }): Promise<Result<readonly CatalogueSectionView[]>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.read);
    if (!allowed.ok) return allowed;
    return ok(tree(await this.readModel.catalogue()));
  }
}

@Injectable()
export class GetSectionUseCase {
  constructor(
    private readonly access: AcademicAccess,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sectionId: string;
  }): Promise<Result<CatalogueSectionView>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.read, {
      type: AcademicResources.section,
      id: command.sectionId,
    });
    if (!allowed.ok) return allowed;
    const catalogue = await this.readModel.sectionCatalogue(command.sectionId);
    const [section] = catalogue === null ? [] : tree(catalogue);
    return section === undefined ? err(SECTION_NOT_FOUND) : ok(section);
  }
}

/** A program, the section it is in, and its halaqat in order. */
@Injectable()
export class GetProgramUseCase {
  constructor(
    private readonly access: AcademicAccess,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly programId: string;
  }): Promise<Result<ProgramDetailView>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.read, {
      type: AcademicResources.program,
      id: command.programId,
    });
    if (!allowed.ok) return allowed;
    const program = await this.repository.findProgram(command.programId);
    if (program === null) return err(PROGRAM_NOT_FOUND);
    const section = await this.repository.findSection(program.sectionId);
    if (section === null) return err(PROGRAM_NOT_FOUND);
    const halaqat = await this.readModel.halaqatOf(program.id);
    const active = halaqat.filter((halaqa) => halaqa.status === 'ACTIVE').length;
    return ok({
      program: programView(program, active),
      section: sectionView(section),
      halaqat: halaqat.map(halaqaView),
    });
  }
}

/** A halaqa and where it sits. Who is in it is a separate, narrower question. */
@Injectable()
export class GetHalaqaUseCase {
  constructor(
    private readonly access: AcademicAccess,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly halaqaId: string;
  }): Promise<Result<HalaqaDetailView>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.read, {
      type: AcademicResources.halaqa,
      id: command.halaqaId,
    });
    if (!allowed.ok) return allowed;
    const placement = await this.repository.placement(command.halaqaId);
    if (placement === null) return err(HALAQA_NOT_FOUND);
    const { program, section } = placementView(placement);
    return ok({ halaqa: halaqaView(placement.halaqa), program, section });
  }
}
