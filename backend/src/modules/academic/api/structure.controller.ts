import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';

import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { CallMetadata, Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import {
  GetCatalogueUseCase,
  GetHalaqaUseCase,
  GetProgramUseCase,
  GetSectionUseCase,
} from '../application/catalogue.use-cases';
import {
  ChangeHalaqaStatusUseCase,
  ChangeProgramStatusUseCase,
  ChangeSectionStatusUseCase,
  CreateHalaqaUseCase,
  CreateProgramUseCase,
  CreateSectionUseCase,
  UpdateHalaqaUseCase,
  UpdateProgramUseCase,
  UpdateSectionUseCase,
} from '../application/structure.use-cases';
import {
  CreateHalaqaDto,
  CreateProgramDto,
  CreateSectionDto,
  UpdateHalaqaDto,
  UpdateStructureDto,
} from './dto/academic.dto';
import {
  toCatalogueSectionResponse,
  toHalaqaDetailResponse,
  toHalaqaResponse,
  toProgramDetailResponse,
  toProgramResponse,
  toSectionResponse,
} from './responses';

/** Only the fields a request actually sent: an omitted field is left alone, `null` clears. */
function changeOf(dto: UpdateStructureDto) {
  return {
    ...(dto.name !== undefined ? { name: dto.name } : {}),
    ...(dto.order !== undefined ? { order: dto.order } : {}),
    ...(dto.description !== undefined ? { description: dto.description } : {}),
  };
}

/**
 * The academic structure: sections, programs, halaqat.
 *
 * Reading it is `academic.read` — every role; changing it is
 * `academic.manage`. Status changes are explicit operations (activate /
 * deactivate), never a writable field, and nothing is ever deleted. Each use
 * case re-checks the permission with the resource named.
 */
@Controller('academic')
export class AcademicStructureController {
  constructor(
    private readonly catalogue: GetCatalogueUseCase,
    private readonly getSection: GetSectionUseCase,
    private readonly getProgram: GetProgramUseCase,
    private readonly getHalaqa: GetHalaqaUseCase,
    private readonly createSection: CreateSectionUseCase,
    private readonly updateSection: UpdateSectionUseCase,
    private readonly sectionStatus: ChangeSectionStatusUseCase,
    private readonly createProgram: CreateProgramUseCase,
    private readonly updateProgram: UpdateProgramUseCase,
    private readonly programStatus: ChangeProgramStatusUseCase,
    private readonly createHalaqa: CreateHalaqaUseCase,
    private readonly updateHalaqa: UpdateHalaqaUseCase,
    private readonly halaqaStatus: ChangeHalaqaStatusUseCase,
  ) {}

  // ── Reading ──────────────────────────────────────────────────────────────

  /** The whole catalogue: every section with its programs. */
  @Get('sections')
  @RequirePermission(Permissions.academic.read)
  async sections(@CurrentPrincipal() principal: Principal) {
    const sections = unwrap(await this.catalogue.execute({ principal }));
    return { sections: sections.map(toCatalogueSectionResponse) };
  }

  @Get('sections/:sectionId')
  @RequirePermission(Permissions.academic.read)
  async section(@CurrentPrincipal() principal: Principal, @Param('sectionId') sectionId: string) {
    return toCatalogueSectionResponse(
      unwrap(await this.getSection.execute({ principal, sectionId })),
    );
  }

  @Get('programs/:programId')
  @RequirePermission(Permissions.academic.read)
  async program(@CurrentPrincipal() principal: Principal, @Param('programId') programId: string) {
    return toProgramDetailResponse(unwrap(await this.getProgram.execute({ principal, programId })));
  }

  @Get('halaqat/:halaqaId')
  @RequirePermission(Permissions.academic.read)
  async halaqa(@CurrentPrincipal() principal: Principal, @Param('halaqaId') halaqaId: string) {
    return toHalaqaDetailResponse(unwrap(await this.getHalaqa.execute({ principal, halaqaId })));
  }

  // ── Sections ─────────────────────────────────────────────────────────────

  @Post('sections')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.CREATED)
  async addSection(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateSectionDto,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toSectionResponse(
      unwrap(
        await this.createSection.execute({
          principal,
          code: dto.code,
          name: dto.name,
          kind: dto.kind,
          order: dto.order,
          description: dto.description,
          meta,
        }),
      ),
    );
  }

  @Patch('sections/:sectionId')
  @RequirePermission(Permissions.academic.manage)
  async editSection(
    @CurrentPrincipal() principal: Principal,
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateStructureDto,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toSectionResponse(
      unwrap(
        await this.updateSection.execute({ principal, sectionId, change: changeOf(dto), meta }),
      ),
    );
  }

  @Post('sections/:sectionId/activate')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.OK)
  async activateSection(
    @CurrentPrincipal() principal: Principal,
    @Param('sectionId') sectionId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toSectionResponse(
      unwrap(await this.sectionStatus.execute({ principal, sectionId, status: 'ACTIVE', meta })),
    );
  }

  @Post('sections/:sectionId/deactivate')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.OK)
  async deactivateSection(
    @CurrentPrincipal() principal: Principal,
    @Param('sectionId') sectionId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toSectionResponse(
      unwrap(await this.sectionStatus.execute({ principal, sectionId, status: 'INACTIVE', meta })),
    );
  }

  // ── Programs ─────────────────────────────────────────────────────────────

  @Post('programs')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.CREATED)
  async addProgram(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateProgramDto,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toProgramResponse(
      unwrap(
        await this.createProgram.execute({
          principal,
          sectionId: dto.sectionId,
          code: dto.code,
          name: dto.name,
          order: dto.order,
          description: dto.description,
          meta,
        }),
      ),
    );
  }

  @Patch('programs/:programId')
  @RequirePermission(Permissions.academic.manage)
  async editProgram(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
    @Body() dto: UpdateStructureDto,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toProgramResponse(
      unwrap(
        await this.updateProgram.execute({ principal, programId, change: changeOf(dto), meta }),
      ),
    );
  }

  @Post('programs/:programId/activate')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.OK)
  async activateProgram(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toProgramResponse(
      unwrap(await this.programStatus.execute({ principal, programId, status: 'ACTIVE', meta })),
    );
  }

  @Post('programs/:programId/deactivate')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.OK)
  async deactivateProgram(
    @CurrentPrincipal() principal: Principal,
    @Param('programId') programId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toProgramResponse(
      unwrap(await this.programStatus.execute({ principal, programId, status: 'INACTIVE', meta })),
    );
  }

  // ── Halaqat ──────────────────────────────────────────────────────────────

  @Post('halaqat')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.CREATED)
  async addHalaqa(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateHalaqaDto,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toHalaqaResponse(
      unwrap(
        await this.createHalaqa.execute({
          principal,
          programId: dto.programId,
          code: dto.code,
          name: dto.name,
          order: dto.order,
          meta,
        }),
      ),
    );
  }

  @Patch('halaqat/:halaqaId')
  @RequirePermission(Permissions.academic.manage)
  async editHalaqa(
    @CurrentPrincipal() principal: Principal,
    @Param('halaqaId') halaqaId: string,
    @Body() dto: UpdateHalaqaDto,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toHalaqaResponse(
      unwrap(
        await this.updateHalaqa.execute({
          principal,
          halaqaId,
          change: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.order !== undefined ? { order: dto.order } : {}),
          },
          meta,
        }),
      ),
    );
  }

  @Post('halaqat/:halaqaId/activate')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.OK)
  async activateHalaqa(
    @CurrentPrincipal() principal: Principal,
    @Param('halaqaId') halaqaId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toHalaqaResponse(
      unwrap(await this.halaqaStatus.execute({ principal, halaqaId, status: 'ACTIVE', meta })),
    );
  }

  @Post('halaqat/:halaqaId/deactivate')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.OK)
  async deactivateHalaqa(
    @CurrentPrincipal() principal: Principal,
    @Param('halaqaId') halaqaId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toHalaqaResponse(
      unwrap(await this.halaqaStatus.execute({ principal, halaqaId, status: 'INACTIVE', meta })),
    );
  }
}
