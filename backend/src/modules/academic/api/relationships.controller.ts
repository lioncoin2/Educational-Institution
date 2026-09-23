import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { RequestMetadata } from '../../../platform/http/call-metadata.decorator';
import { CurrentPrincipal } from '../../../platform/http/current-principal.decorator';
import { unwrap } from '../../../platform/http/http-failure';
import type { CallMetadata, Principal } from '../../../shared';
import { Permissions } from '../../identity/contracts/permissions';
import { RequirePermission } from '../../identity/contracts/route-access';
import {
  EndEnrollmentUseCase,
  EnrollStudentUseCase,
  ListHalaqaStudentsUseCase,
  ListStudentEnrollmentsUseCase,
} from '../application/enrollment.use-cases';
import {
  AssignTeacherUseCase,
  EndTeacherAssignmentUseCase,
  ListHalaqaTeachersUseCase,
  ListTeacherAssignmentsUseCase,
} from '../application/teaching.use-cases';
import {
  AssignTeacherDto,
  EndEnrollmentDto,
  EnrollStudentDto,
  PageQuery,
  StatusPageQuery,
} from './dto/academic.dto';
import {
  toAssignmentResponse,
  toEnrollmentResponse,
  toPageResponse,
  toPlacedAssignmentResponse,
  toPlacedEnrollmentResponse,
  toRosterEntryResponse,
  toTeacherEntryResponse,
} from './responses';

/**
 * Who studies and who teaches in a halaqa.
 *
 * Listing a halaqa's people is gated twice: `academic.read` on the route, then
 * the use case — academic administrators see any halaqa, a teacher only the
 * halaqat they are assigned to, nobody else any. Enrolling, assigning and
 * ending either is `academic.manage`. Enrolling or assigning someone who is
 * already there answers 200 with what exists; a new record answers 201.
 */
@Controller('academic')
export class AcademicRelationshipsController {
  constructor(
    private readonly listStudents: ListHalaqaStudentsUseCase,
    private readonly enroll: EnrollStudentUseCase,
    private readonly endEnrollment: EndEnrollmentUseCase,
    private readonly studentEnrollments: ListStudentEnrollmentsUseCase,
    private readonly listTeachers: ListHalaqaTeachersUseCase,
    private readonly assign: AssignTeacherUseCase,
    private readonly endAssignment: EndTeacherAssignmentUseCase,
    private readonly teacherAssignments: ListTeacherAssignmentsUseCase,
  ) {}

  // ── Students ─────────────────────────────────────────────────────────────

  @Get('halaqat/:halaqaId/students')
  @RequirePermission(Permissions.academic.read)
  async students(
    @CurrentPrincipal() principal: Principal,
    @Param('halaqaId') halaqaId: string,
    @Query() query: StatusPageQuery,
  ) {
    return toPageResponse(
      unwrap(
        await this.listStudents.execute({
          principal,
          halaqaId,
          status: query.status,
          cursor: query.cursor,
          limit: query.limit,
        }),
      ),
      toRosterEntryResponse,
    );
  }

  @Post('halaqat/:halaqaId/enrollments')
  @RequirePermission(Permissions.academic.manage)
  async enrollStudent(
    @CurrentPrincipal() principal: Principal,
    @Param('halaqaId') halaqaId: string,
    @Body() dto: EnrollStudentDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(
      await this.enroll.execute({ principal, halaqaId, studentUserId: dto.studentUserId, meta }),
    );
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return toPlacedEnrollmentResponse(result);
  }

  @Post('enrollments/:enrollmentId/end')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.OK)
  async end(
    @CurrentPrincipal() principal: Principal,
    @Param('enrollmentId') enrollmentId: string,
    @Body() dto: EndEnrollmentDto,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toEnrollmentResponse(
      unwrap(
        await this.endEnrollment.execute({ principal, enrollmentId, outcome: dto.outcome, meta }),
      ),
    );
  }

  @Get('students/:userId/enrollments')
  @RequirePermission(Permissions.academic.manage)
  async enrollmentsOf(
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Query() query: PageQuery,
  ) {
    return toPageResponse(
      unwrap(
        await this.studentEnrollments.execute({
          principal,
          studentUserId: userId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      ),
      toPlacedEnrollmentResponse,
    );
  }

  // ── Teachers ─────────────────────────────────────────────────────────────

  @Get('halaqat/:halaqaId/teachers')
  @RequirePermission(Permissions.academic.read)
  async teachers(
    @CurrentPrincipal() principal: Principal,
    @Param('halaqaId') halaqaId: string,
    @Query() query: StatusPageQuery,
  ) {
    return toPageResponse(
      unwrap(
        await this.listTeachers.execute({
          principal,
          halaqaId,
          status: query.status,
          cursor: query.cursor,
          limit: query.limit,
        }),
      ),
      toTeacherEntryResponse,
    );
  }

  @Post('halaqat/:halaqaId/teachers')
  @RequirePermission(Permissions.academic.manage)
  async assignTeacher(
    @CurrentPrincipal() principal: Principal,
    @Param('halaqaId') halaqaId: string,
    @Body() dto: AssignTeacherDto,
    @RequestMetadata() meta: CallMetadata,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = unwrap(
      await this.assign.execute({
        principal,
        halaqaId,
        teacherUserId: dto.teacherUserId,
        role: dto.role,
        meta,
      }),
    );
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return toAssignmentResponse(result.assignment);
  }

  @Post('teacher-assignments/:assignmentId/end')
  @RequirePermission(Permissions.academic.manage)
  @HttpCode(HttpStatus.OK)
  async endTeaching(
    @CurrentPrincipal() principal: Principal,
    @Param('assignmentId') assignmentId: string,
    @RequestMetadata() meta: CallMetadata,
  ) {
    return toAssignmentResponse(
      unwrap(await this.endAssignment.execute({ principal, assignmentId, meta })),
    );
  }

  @Get('teachers/:userId/assignments')
  @RequirePermission(Permissions.academic.manage)
  async assignmentsOf(
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Query() query: PageQuery,
  ) {
    return toPageResponse(
      unwrap(
        await this.teacherAssignments.execute({
          principal,
          teacherUserId: userId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      ),
      toPlacedAssignmentResponse,
    );
  }
}
