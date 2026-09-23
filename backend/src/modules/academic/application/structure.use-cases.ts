import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  err,
  failure,
  ok,
  type CallMetadata,
  type Clock,
  type Failure,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import type { StructureStatus } from '../contracts/vocabulary';
import { AcademicLimits } from '../domain/academic-policy';
import {
  halaqaCreated,
  halaqaStatusChanged,
  halaqaUpdated,
  programCreated,
  programStatusChanged,
  programUpdated,
  sectionCreated,
  sectionStatusChanged,
  sectionUpdated,
} from '../domain/events';
import {
  ACADEMIC_READ_MODEL,
  ACADEMIC_REPOSITORY,
  type AcademicReadModel,
  type AcademicRepository,
  type CreateOutcome,
} from '../domain/ports';
import {
  applyChange,
  applyHalaqaChange,
  createHalaqa,
  createProgram,
  createSection,
  type Halaqa,
  type Program,
  type ProgramId,
  type SectionId,
  type StructureChange,
} from '../domain/structure';
import { AcademicAccess, HALAQA_NOT_FOUND } from './academic-access';
import { AcademicJournal } from './academic-journal';
import { AcademicAudit, AcademicResources } from './academic-settings';
import { PROGRAM_NOT_FOUND, SECTION_NOT_FOUND } from './catalogue.use-cases';
import {
  halaqaView,
  programView,
  sectionView,
  type HalaqaView,
  type ProgramView,
  type SectionView,
} from './views';

const CODE_TAKEN = failure(
  'conflict',
  'academic.code_taken',
  'That code is already in use. Codes are unique and never reused.',
);

function created(
  outcome: CreateOutcome,
  parentMissing: Failure,
  tooMany: (limit: number) => Failure,
): Result<void> {
  switch (outcome.kind) {
    case 'created':
      return ok(undefined);
    case 'code_taken':
      return err(CODE_TAKEN);
    case 'parent_not_found':
      return err(parentMissing);
    case 'limit_reached':
      return err(tooMany(outcome.limit));
  }
}

/** Every change to the structure is academic.manage — and is audited. */
function manage(access: AcademicAccess, principal: Principal, type: string, id?: string) {
  return access.authorize(
    principal,
    Permissions.academic.manage,
    id === undefined ? undefined : { type, id },
  );
}

async function activeHalaqaCount(readModel: AcademicReadModel, program: Program): Promise<number> {
  const halaqat = await readModel.halaqatOf(program.id);
  return halaqat.filter((halaqa) => halaqa.status === 'ACTIVE').length;
}

// ── Sections ───────────────────────────────────────────────────────────────

@Injectable()
export class CreateSectionUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly code: string;
    readonly name: string;
    readonly kind: string;
    readonly order: number;
    readonly description?: string | null;
    readonly meta: CallMetadata;
  }): Promise<Result<SectionView>> {
    const allowed = manage(this.access, command.principal, AcademicResources.section);
    if (!allowed.ok) return allowed;
    const section = createSection({
      id: this.ids.next<'AcademicSection'>(),
      code: command.code,
      name: command.name,
      kind: command.kind,
      order: command.order,
      description: command.description,
      at: this.clock.now(),
    });
    if (!section.ok) return section;
    const stored = created(
      await this.repository.createSection(section.value, AcademicLimits.maxSections),
      SECTION_NOT_FOUND,
      (limit) =>
        failure(
          'precondition_failed',
          'academic.too_many_sections',
          `There may be at most ${limit} sections.`,
          { limit },
        ),
    );
    if (!stored.ok) return stored;

    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action: AcademicAudit.sectionCreated,
        resourceType: AcademicResources.section,
        resourceId: section.value.id,
        at: section.value.createdAt,
        metadata: { code: section.value.code, kind: section.value.kind },
        correlationId: command.meta.correlationId,
      },
      sectionCreated(section.value, command.meta.correlationId),
    );
    return ok(sectionView(section.value));
  }
}

@Injectable()
export class UpdateSectionUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sectionId: string;
    readonly change: StructureChange;
    readonly meta: CallMetadata;
  }): Promise<Result<SectionView>> {
    const allowed = manage(
      this.access,
      command.principal,
      AcademicResources.section,
      command.sectionId,
    );
    if (!allowed.ok) return allowed;
    const section = await this.repository.findSection(command.sectionId);
    if (section === null) return err(SECTION_NOT_FOUND);
    const applied = applyChange(section, command.change, this.clock.now());
    if (!applied.ok) return applied;
    const { entity, changed } = applied.value;
    if (changed.length === 0) return ok(sectionView(section));

    await this.repository.saveSection(entity);
    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action: AcademicAudit.sectionUpdated,
        resourceType: AcademicResources.section,
        resourceId: entity.id,
        at: entity.updatedAt,
        metadata: { changed },
        correlationId: command.meta.correlationId,
      },
      sectionUpdated(entity, changed, command.meta.correlationId),
    );
    return ok(sectionView(entity));
  }
}

/**
 * Activating or deactivating a section. An INACTIVE section accepts no new
 * enrollment in any of its halaqat; everything already there — enrollments,
 * programs, halaqat — is untouched and stays readable.
 */
@Injectable()
export class ChangeSectionStatusUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sectionId: string;
    readonly status: StructureStatus;
    readonly meta: CallMetadata;
  }): Promise<Result<SectionView>> {
    const allowed = manage(
      this.access,
      command.principal,
      AcademicResources.section,
      command.sectionId,
    );
    if (!allowed.ok) return allowed;
    const outcome = await this.repository.setSectionStatus(
      command.sectionId,
      command.status,
      this.clock.now(),
    );
    if (outcome.kind === 'not_found') return err(SECTION_NOT_FOUND);
    if (outcome.kind === 'unchanged') return ok(sectionView(outcome.entity));

    const section = outcome.entity;
    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action:
          section.status === 'ACTIVE'
            ? AcademicAudit.sectionActivated
            : AcademicAudit.sectionDeactivated,
        resourceType: AcademicResources.section,
        resourceId: section.id,
        at: section.updatedAt,
        metadata: { code: section.code },
        correlationId: command.meta.correlationId,
      },
      sectionStatusChanged(section, command.meta.correlationId),
    );
    return ok(sectionView(section));
  }
}

// ── Programs ───────────────────────────────────────────────────────────────

@Injectable()
export class CreateProgramUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly sectionId: string;
    readonly code: string;
    readonly name: string;
    readonly order: number;
    readonly description?: string | null;
    readonly meta: CallMetadata;
  }): Promise<Result<ProgramView>> {
    const allowed = manage(
      this.access,
      command.principal,
      AcademicResources.section,
      command.sectionId,
    );
    if (!allowed.ok) return allowed;
    const program = createProgram({
      id: this.ids.next<'AcademicProgram'>(),
      sectionId: command.sectionId as SectionId,
      code: command.code,
      name: command.name,
      order: command.order,
      description: command.description,
      at: this.clock.now(),
    });
    if (!program.ok) return program;
    const stored = created(
      await this.repository.createProgram(program.value, AcademicLimits.maxProgramsPerSection),
      SECTION_NOT_FOUND,
      (limit) =>
        failure(
          'precondition_failed',
          'academic.too_many_programs',
          `A section may have at most ${limit} programs.`,
          { limit },
        ),
    );
    if (!stored.ok) return stored;

    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action: AcademicAudit.programCreated,
        resourceType: AcademicResources.program,
        resourceId: program.value.id,
        at: program.value.createdAt,
        metadata: { code: program.value.code, sectionId: program.value.sectionId },
        correlationId: command.meta.correlationId,
      },
      programCreated(program.value, command.meta.correlationId),
    );
    return ok(programView(program.value, 0));
  }
}

@Injectable()
export class UpdateProgramUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly programId: string;
    readonly change: StructureChange;
    readonly meta: CallMetadata;
  }): Promise<Result<ProgramView>> {
    const allowed = manage(
      this.access,
      command.principal,
      AcademicResources.program,
      command.programId,
    );
    if (!allowed.ok) return allowed;
    const program = await this.repository.findProgram(command.programId);
    if (program === null) return err(PROGRAM_NOT_FOUND);
    const applied = applyChange(program, command.change, this.clock.now());
    if (!applied.ok) return applied;
    const { entity, changed } = applied.value;
    if (changed.length > 0) {
      await this.repository.saveProgram(entity);
      await this.journal.record(
        {
          actorUserId: this.access.actorOf(command.principal),
          action: AcademicAudit.programUpdated,
          resourceType: AcademicResources.program,
          resourceId: entity.id,
          at: entity.updatedAt,
          metadata: { changed },
          correlationId: command.meta.correlationId,
        },
        programUpdated(entity, changed, command.meta.correlationId),
      );
    }
    return ok(programView(entity, await activeHalaqaCount(this.readModel, entity)));
  }
}

/**
 * An INACTIVE program accepts no new enrollment in any of its halaqat;
 * current enrollments continue and everything stays readable.
 */
@Injectable()
export class ChangeProgramStatusUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly programId: string;
    readonly status: StructureStatus;
    readonly meta: CallMetadata;
  }): Promise<Result<ProgramView>> {
    const allowed = manage(
      this.access,
      command.principal,
      AcademicResources.program,
      command.programId,
    );
    if (!allowed.ok) return allowed;
    const outcome = await this.repository.setProgramStatus(
      command.programId,
      command.status,
      this.clock.now(),
    );
    if (outcome.kind === 'not_found') return err(PROGRAM_NOT_FOUND);
    const program = outcome.entity;
    if (outcome.kind === 'changed') {
      await this.journal.record(
        {
          actorUserId: this.access.actorOf(command.principal),
          action:
            program.status === 'ACTIVE'
              ? AcademicAudit.programActivated
              : AcademicAudit.programDeactivated,
          resourceType: AcademicResources.program,
          resourceId: program.id,
          at: program.updatedAt,
          metadata: { code: program.code, sectionId: program.sectionId },
          correlationId: command.meta.correlationId,
        },
        programStatusChanged(program, command.meta.correlationId),
      );
    }
    return ok(programView(program, await activeHalaqaCount(this.readModel, program)));
  }
}

// ── Halaqat ────────────────────────────────────────────────────────────────

@Injectable()
export class CreateHalaqaUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly programId: string;
    readonly code: string;
    readonly name: string;
    readonly order: number;
    readonly meta: CallMetadata;
  }): Promise<Result<HalaqaView>> {
    const allowed = manage(
      this.access,
      command.principal,
      AcademicResources.program,
      command.programId,
    );
    if (!allowed.ok) return allowed;
    const halaqa = createHalaqa({
      id: this.ids.next<'AcademicHalaqa'>(),
      programId: command.programId as ProgramId,
      code: command.code,
      name: command.name,
      order: command.order,
      at: this.clock.now(),
    });
    if (!halaqa.ok) return halaqa;
    const stored = created(
      await this.repository.createHalaqa(halaqa.value, AcademicLimits.maxHalaqatPerProgram),
      PROGRAM_NOT_FOUND,
      (limit) =>
        failure(
          'precondition_failed',
          'academic.too_many_halaqat',
          `A program may have at most ${limit} halaqat.`,
          { limit },
        ),
    );
    if (!stored.ok) return stored;

    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action: AcademicAudit.halaqaCreated,
        resourceType: AcademicResources.halaqa,
        resourceId: halaqa.value.id,
        at: halaqa.value.createdAt,
        metadata: { code: halaqa.value.code, programId: halaqa.value.programId },
        correlationId: command.meta.correlationId,
      },
      halaqaCreated(halaqa.value, command.meta.correlationId),
    );
    return ok(halaqaView(halaqa.value));
  }
}

@Injectable()
export class UpdateHalaqaUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly halaqaId: string;
    readonly change: Omit<StructureChange, 'description'>;
    readonly meta: CallMetadata;
  }): Promise<Result<HalaqaView>> {
    const allowed = manage(
      this.access,
      command.principal,
      AcademicResources.halaqa,
      command.halaqaId,
    );
    if (!allowed.ok) return allowed;
    const halaqa = await this.repository.findHalaqa(command.halaqaId);
    if (halaqa === null) return err(HALAQA_NOT_FOUND);
    const applied = applyHalaqaChange(halaqa, command.change, this.clock.now());
    if (!applied.ok) return applied;
    const { entity, changed } = applied.value;
    if (changed.length === 0) return ok(halaqaView(halaqa));

    await this.repository.saveHalaqa(entity);
    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action: AcademicAudit.halaqaUpdated,
        resourceType: AcademicResources.halaqa,
        resourceId: entity.id,
        at: entity.updatedAt,
        metadata: { changed },
        correlationId: command.meta.correlationId,
      },
      halaqaUpdated(entity, changed, command.meta.correlationId),
    );
    return ok(halaqaView(entity));
  }
}

/**
 * Activating or deactivating a halaqa. Deactivation is refused while the
 * halaqa has ACTIVE enrollments: the institution ends each of them — as
 * completed or withdrawn, its decision — first. So there is never an active
 * enrollment in an inactive halaqa, and no outcome is invented on anyone's
 * behalf. Teacher assignments are left as they are (Q32).
 */
@Injectable()
export class ChangeHalaqaStatusUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly halaqaId: string;
    readonly status: StructureStatus;
    readonly meta: CallMetadata;
  }): Promise<Result<HalaqaView>> {
    const allowed = manage(
      this.access,
      command.principal,
      AcademicResources.halaqa,
      command.halaqaId,
    );
    if (!allowed.ok) return allowed;
    const at = this.clock.now();
    const outcome =
      command.status === 'ACTIVE'
        ? await this.repository.activateHalaqa(command.halaqaId, at)
        : await this.repository.deactivateHalaqa(command.halaqaId, at);
    if (outcome.kind === 'not_found') return err(HALAQA_NOT_FOUND);
    if (outcome.kind === 'has_active_enrollments') {
      return err(
        failure(
          'precondition_failed',
          'academic.halaqa_has_active_enrollments',
          'This halaqa still has active enrollments. End each of them first.',
        ),
      );
    }
    const halaqa: Halaqa = outcome.entity;
    if (outcome.kind === 'changed') {
      await this.journal.record(
        {
          actorUserId: this.access.actorOf(command.principal),
          action:
            halaqa.status === 'ACTIVE'
              ? AcademicAudit.halaqaActivated
              : AcademicAudit.halaqaDeactivated,
          resourceType: AcademicResources.halaqa,
          resourceId: halaqa.id,
          at: halaqa.updatedAt,
          metadata: { code: halaqa.code, programId: halaqa.programId },
          correlationId: command.meta.correlationId,
        },
        halaqaStatusChanged(halaqa, command.meta.correlationId),
      );
    }
    return ok(halaqaView(halaqa));
  }
}
