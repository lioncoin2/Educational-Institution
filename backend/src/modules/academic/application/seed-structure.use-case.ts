import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import {
  CLOCK,
  ID_GENERATOR,
  err,
  failure,
  ok,
  type CallMetadata,
  type Clock,
  type IdGenerator,
  type Principal,
  type Result,
} from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { systemPrincipal } from '../../identity/contracts/principal';
import { AcademicLimits } from '../domain/academic-policy';
import { halaqaCreated, programCreated, sectionCreated } from '../domain/events';
import { ACADEMIC_REPOSITORY, type AcademicRepository } from '../domain/ports';
import {
  createHalaqa,
  createProgram,
  createSection,
  type Halaqa,
  type Program,
  type Section,
} from '../domain/structure';
import { AcademicAccess } from './academic-access';
import { AcademicJournal } from './academic-journal';
import { AcademicAudit, AcademicResources } from './academic-settings';
import {
  INSTITUTION_STRUCTURE,
  seededHalaqaCode,
  seededHalaqaName,
  type InstitutionStructure,
} from './institution-structure';

/** Who seeds: a system principal that may manage academic structure and nothing else. */
export const STRUCTURE_SEEDER = systemPrincipal('academic-structure-seed', [
  Permissions.academic.manage,
]);

export interface SeedCount {
  readonly created: number;
  /** Already there — left exactly as found, even if an administrator changed it. */
  readonly existing: number;
}

export interface SeedReport {
  readonly sections: SeedCount;
  readonly programs: SeedCount;
  readonly halaqat: SeedCount;
}

class Tally {
  created = 0;
  existing = 0;
  get count(): SeedCount {
    return { created: this.created, existing: this.existing };
  }
}

const SOURCE = 'institution-profile';

/**
 * Seeds the institution's structure from its profile — the sections, the
 * programs, and the halaqat the profile counts — and nothing else: no
 * students, no teachers, no progress, no descriptions.
 *
 * Idempotent by code. Whatever already exists is left exactly as it is: an
 * administrator's renaming, reordering or deactivating is never undone by a
 * second run. Each entity actually created is audited (actor: the system) and
 * announced like any other creation.
 *
 * It is an explicit bootstrap step — `npm run academic:seed-structure` — not
 * a schema migration: the structure is the institution's data, which it will
 * change, not part of the schema (docs/architecture/academic.md, "Seeding").
 */
@Injectable()
export class SeedInstitutionStructureUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly meta: CallMetadata;
    /** Defaults to the profile's structure; tests pass smaller ones. */
    readonly structure?: InstitutionStructure;
  }): Promise<Result<SeedReport>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.manage);
    if (!allowed.ok) return allowed;
    const structure = command.structure ?? INSTITUTION_STRUCTURE;
    const tallies = { sections: new Tally(), programs: new Tally(), halaqat: new Tally() };
    const record = { principal: command.principal, meta: command.meta };

    for (const spec of structure.sections) {
      const section = await this.section(spec, tallies.sections, record);
      if (!section.ok) return section;
      for (const programSpec of spec.programs) {
        const program = await this.program(section.value, programSpec, tallies.programs, record);
        if (!program.ok) return program;
        for (let position = 1; position <= programSpec.halaqat; position++) {
          const halaqa = await this.halaqa(
            program.value,
            seededHalaqaCode(spec.code, position),
            position,
            tallies.halaqat,
            record,
          );
          if (!halaqa.ok) return halaqa;
        }
      }
    }
    return ok({
      sections: tallies.sections.count,
      programs: tallies.programs.count,
      halaqat: tallies.halaqat.count,
    });
  }

  private async section(
    spec: InstitutionStructure['sections'][number],
    tally: Tally,
    record: { readonly principal: Principal; readonly meta: CallMetadata },
  ): Promise<Result<Section>> {
    const existing = await this.repository.sectionByCode(spec.code);
    if (existing !== null) {
      tally.existing++;
      return ok(existing);
    }
    const section = createSection({
      id: this.ids.next<'AcademicSection'>(),
      code: spec.code,
      name: spec.name,
      kind: spec.kind,
      order: spec.order,
      at: this.clock.now(),
    });
    if (!section.ok) return section;
    const outcome = await this.repository.createSection(section.value, AcademicLimits.maxSections);
    if (outcome.kind === 'code_taken')
      return this.raced(await this.repository.sectionByCode(spec.code), tally);
    if (outcome.kind !== 'created') return err(unseedable(spec.code));
    tally.created++;
    await this.journal.record(
      {
        actorUserId: this.access.actorOf(record.principal),
        action: AcademicAudit.sectionCreated,
        resourceType: AcademicResources.section,
        resourceId: section.value.id,
        at: section.value.createdAt,
        metadata: { code: section.value.code, kind: section.value.kind, source: SOURCE },
        correlationId: record.meta.correlationId,
      },
      sectionCreated(section.value, record.meta.correlationId),
    );
    return section;
  }

  private async program(
    section: Section,
    spec: InstitutionStructure['sections'][number]['programs'][number],
    tally: Tally,
    record: { readonly principal: Principal; readonly meta: CallMetadata },
  ): Promise<Result<Program>> {
    const existing = await this.repository.programByCode(spec.code);
    if (existing !== null) {
      tally.existing++;
      return ok(existing);
    }
    const program = createProgram({
      id: this.ids.next<'AcademicProgram'>(),
      sectionId: section.id,
      code: spec.code,
      name: spec.name,
      order: spec.order,
      at: this.clock.now(),
    });
    if (!program.ok) return program;
    const outcome = await this.repository.createProgram(
      program.value,
      AcademicLimits.maxProgramsPerSection,
    );
    if (outcome.kind === 'code_taken')
      return this.raced(await this.repository.programByCode(spec.code), tally);
    if (outcome.kind !== 'created') return err(unseedable(spec.code));
    tally.created++;
    await this.journal.record(
      {
        actorUserId: this.access.actorOf(record.principal),
        action: AcademicAudit.programCreated,
        resourceType: AcademicResources.program,
        resourceId: program.value.id,
        at: program.value.createdAt,
        metadata: { code: program.value.code, sectionId: section.id, source: SOURCE },
        correlationId: record.meta.correlationId,
      },
      programCreated(program.value, record.meta.correlationId),
    );
    return program;
  }

  private async halaqa(
    program: Program,
    code: string,
    position: number,
    tally: Tally,
    record: { readonly principal: Principal; readonly meta: CallMetadata },
  ): Promise<Result<Halaqa>> {
    const existing = await this.repository.halaqaByCode(code);
    if (existing !== null) {
      tally.existing++;
      return ok(existing);
    }
    const halaqa = createHalaqa({
      id: this.ids.next<'AcademicHalaqa'>(),
      programId: program.id,
      code,
      name: seededHalaqaName(position),
      order: position,
      at: this.clock.now(),
    });
    if (!halaqa.ok) return halaqa;
    const outcome = await this.repository.createHalaqa(
      halaqa.value,
      AcademicLimits.maxHalaqatPerProgram,
    );
    if (outcome.kind === 'code_taken')
      return this.raced(await this.repository.halaqaByCode(code), tally);
    if (outcome.kind !== 'created') return err(unseedable(code));
    tally.created++;
    await this.journal.record(
      {
        actorUserId: this.access.actorOf(record.principal),
        action: AcademicAudit.halaqaCreated,
        resourceType: AcademicResources.halaqa,
        resourceId: halaqa.value.id,
        at: halaqa.value.createdAt,
        metadata: { code, programId: program.id, source: SOURCE },
        correlationId: record.meta.correlationId,
      },
      halaqaCreated(halaqa.value, record.meta.correlationId),
    );
    return halaqa;
  }

  /** Another run created it between our look and our write: it exists, which is all we wanted. */
  private raced<T>(found: T | null, tally: Tally): Result<T> {
    if (found === null) return err(unseedable('unknown'));
    tally.existing++;
    return ok(found);
  }
}

function unseedable(code: string) {
  return failure(
    'precondition_failed',
    'academic.seed_failed',
    `Could not seed "${code}": its parent is missing or a structural limit was reached.`,
    { code },
  );
}

/**
 * Without a database the application runs on the in-memory store, which
 * starts empty on every boot; this seeds it from the profile so a
 * development server shows the institution's structure. It never runs
 * against Postgres — there, seeding is the explicit command.
 */
export class DevelopmentStructureSeed implements OnApplicationBootstrap {
  private readonly logger = new Logger('AcademicStructure');

  constructor(
    private readonly enabled: boolean,
    private readonly seed: SeedInstitutionStructureUseCase,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    const result = await this.seed.execute({
      principal: STRUCTURE_SEEDER,
      meta: { correlationId: 'boot:academic-structure' },
    });
    if (result.ok) {
      this.logger.log(
        { ...result.value },
        'in-memory academic structure seeded from the institution profile',
      );
    } else {
      this.logger.error({ code: result.error.code }, 'could not seed the academic structure');
    }
  }
}
