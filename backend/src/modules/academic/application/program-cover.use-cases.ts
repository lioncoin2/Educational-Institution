import { Inject, Injectable } from '@nestjs/common';

import {
  CLOCK,
  err,
  failure,
  ok,
  type CallMetadata,
  type Clock,
  type Principal,
  type Result,
} from '../../../shared';
import { FILE_ASSETS, type DownloadLink, type FileAssets } from '../../files/contracts/file-assets';
import type { FileKind } from '../../files/contracts/file-kind';
import { Permissions } from '../../identity/contracts/permissions';
import { programUpdated } from '../domain/events';
import {
  ACADEMIC_READ_MODEL,
  ACADEMIC_REPOSITORY,
  type AcademicReadModel,
  type AcademicRepository,
} from '../domain/ports';
import { AcademicAccess } from './academic-access';
import { AcademicJournal } from './academic-journal';
import { AcademicAudit, AcademicResources } from './academic-settings';
import { PROGRAM_NOT_FOUND } from './catalogue.use-cases';
import { programView, type ProgramView } from './views';

/** The cover named is not an image the manager uploaded (Files' own check). */
const PROGRAM_COVER_INVALID = failure(
  'validation',
  'academic.program_cover_invalid',
  'The cover must be an image you have uploaded.',
);

/** A program has no cover image. */
const NO_PROGRAM_COVER = failure(
  'not_found',
  'academic.program_cover_not_found',
  'No program cover.',
);

/** A program's cover is always an image. */
const COVER_KINDS: readonly FileKind[] = ['IMAGE'];

/**
 * Binds or clears a program's cover image (ADR 0038 pattern). Changing it is
 * `academic.manage` — the owner and admins, exactly as every other program
 * change; it is never a writable field of the structured edit. A new cover is
 * verified through the Files contract — an image the manager uploaded — before
 * it is stored, exactly as a community avatar is; clearing it (`null`) needs no
 * verification. Nothing else about the program changes: not its name, order,
 * description, status, halaqat or enrollments.
 */
@Injectable()
export class SetProgramCoverUseCase {
  constructor(
    private readonly access: AcademicAccess,
    private readonly journal: AcademicJournal,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(ACADEMIC_READ_MODEL) private readonly readModel: AcademicReadModel,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly programId: string;
    /** A Files asset id the manager uploaded, or null to clear the cover. */
    readonly coverFileAssetId: string | null;
    readonly meta: CallMetadata;
  }): Promise<Result<ProgramView>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.manage, {
      type: AcademicResources.program,
      id: command.programId,
    });
    if (!allowed.ok) return allowed;

    // Verify a new cover — an image the manager owns — before storing it.
    if (command.coverFileAssetId !== null) {
      const verified = await this.files.verifyAttachable(
        command.coverFileAssetId,
        command.principal.userId,
        COVER_KINDS,
      );
      if (!verified.ok) return err(PROGRAM_COVER_INVALID);
    }

    const at = this.clock.now();
    const program = await this.repository.setProgramCover(
      command.programId,
      command.coverFileAssetId,
      at,
    );
    if (program === null) return err(PROGRAM_NOT_FOUND);

    await this.journal.record(
      {
        actorUserId: this.access.actorOf(command.principal),
        action: AcademicAudit.programUpdated,
        resourceType: AcademicResources.program,
        resourceId: program.id,
        at: program.updatedAt,
        metadata: { changed: ['cover'], hasCover: program.coverFileAssetId !== null },
        correlationId: command.meta.correlationId,
      },
      programUpdated(program, ['cover'], command.meta.correlationId),
    );

    const halaqat = await this.readModel.halaqatOf(program.id);
    const active = halaqat.filter((halaqa) => halaqa.status === 'ACTIVE').length;
    return ok(programView(program, active));
  }
}

/**
 * A short-lived link to a program's cover image. Whoever may read the academic
 * structure (`academic.read`, every role) may see a program's cover, as the
 * catalogue is institution-wide. The stored reference was verified as an image
 * when it was set, so serving it needs no ownership check. No cover reads as
 * "no program cover".
 */
@Injectable()
export class GetProgramCoverLinkUseCase {
  constructor(
    private readonly access: AcademicAccess,
    @Inject(ACADEMIC_REPOSITORY) private readonly repository: AcademicRepository,
    @Inject(FILE_ASSETS) private readonly files: FileAssets,
  ) {}

  async execute(command: {
    readonly principal: Principal;
    readonly programId: string;
    readonly meta: CallMetadata;
  }): Promise<Result<DownloadLink>> {
    const allowed = this.access.authorize(command.principal, Permissions.academic.read, {
      type: AcademicResources.program,
      id: command.programId,
    });
    if (!allowed.ok) return allowed;

    const program = await this.repository.findProgram(command.programId);
    if (program === null) return err(PROGRAM_NOT_FOUND);
    if (program.coverFileAssetId === null) return err(NO_PROGRAM_COVER);

    const link = await this.files.createDownloadLink(program.coverFileAssetId);
    return link.ok ? ok(link.value) : err(NO_PROGRAM_COVER);
  }
}
