import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import {
  DeleteTemplateUseCase,
  ListTemplatesUseCase,
  SaveTemplateUseCase,
} from '../application/templates/template.use-cases';
import { PageQuery } from './dto/tasks.dto';
import { SaveTemplateDto } from './dto/templates.dto';
import { toTemplateResponse, type TemplateResponse } from './responses/admin.responses';
import type { PageResponse } from './responses/wire';

/**
 * Task templates (roadmap §10): saving and removing are the owner's
 * (`tasks.template`); whoever may publish (`tasks.manage`) may start from one.
 */
@Controller('task-templates')
export class TaskTemplatesController {
  constructor(
    private readonly listTemplates: ListTemplatesUseCase,
    private readonly saveTemplate: SaveTemplateUseCase,
    private readonly deleteTemplate: DeleteTemplateUseCase,
  ) {}

  @Get()
  @RequirePermission(Permissions.tasks.manage)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: PageQuery,
  ): Promise<PageResponse<TemplateResponse>> {
    const page = unwrap(
      await this.listTemplates.execute({ principal, cursor: query.cursor, limit: query.limit }),
    );
    return { items: page.items.map(toTemplateResponse), nextCursor: page.nextCursor ?? null };
  }

  @Post()
  @RequirePermission(Permissions.tasks.template)
  async save(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: SaveTemplateDto,
  ): Promise<TemplateResponse> {
    return toTemplateResponse(
      unwrap(
        await this.saveTemplate.execute({
          principal,
          fromTaskId: dto.fromTaskId,
          draft: dto.draft,
        }),
      ),
    );
  }

  @Delete(':templateId')
  @RequirePermission(Permissions.tasks.template)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
  ): Promise<void> {
    unwrap(await this.deleteTemplate.execute({ principal, templateId }));
  }
}
