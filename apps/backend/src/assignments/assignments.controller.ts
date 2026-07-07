import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  Assignment,
  AssignmentDetailResponse,
  AssignmentSubmission,
  AssignmentSubmissionListResponse,
  CreateAssignmentRequest,
  ReviewAssignmentSubmissionRequest,
  StudentAssignmentListResponse,
  SubmitAssignmentRequest,
  TeacherAssignmentListResponse,
  UpdateAssignmentRequest
} from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AssignmentUploadFile, AssignmentsService } from './assignments.service';

const ASSIGNMENT_FILE_MAX_COUNT = 5;
const ASSIGNMENT_FILE_MAX_SIZE_BYTES = 10 * 1024 * 1024;

interface HeaderResponse {
  setHeader(name: string, value: string | number): void;
}

interface AssignmentListQuery {
  batchId?: string;
  sessionId?: string;
}

@ApiTags('assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Post('assignments')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Create a batch assignment' })
  createAssignment(@Body() body: CreateAssignmentRequest, @CurrentUser() user: AuthenticatedUser): Promise<Assignment> {
    return this.assignments.createAssignment(user, body);
  }

  @Get('teacher/assignments')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List assignments for teacher-owned batches' })
  listTeacherAssignments(@Query() query: AssignmentListQuery, @CurrentUser() user: AuthenticatedUser): Promise<TeacherAssignmentListResponse> {
    return this.assignments.listTeacherAssignments(user, query);
  }

  @Get('assignments/:assignmentId')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Get an authorized assignment' })
  getAssignment(@Param('assignmentId') assignmentId: string, @CurrentUser() user: AuthenticatedUser): Promise<AssignmentDetailResponse> {
    return this.assignments.getAssignment(user, assignmentId);
  }

  @Patch('assignments/:assignmentId')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Update an assignment' })
  updateAssignment(
    @Param('assignmentId') assignmentId: string,
    @Body() body: UpdateAssignmentRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<Assignment> {
    return this.assignments.updateAssignment(user, assignmentId, body);
  }

  @Delete('assignments/:assignmentId')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Archive an assignment' })
  archiveAssignment(@Param('assignmentId') assignmentId: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.assignments.archiveAssignment(user, assignmentId);
  }

  @Post('assignments/:assignmentId/attachments')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @UseInterceptors(FilesInterceptor('files', ASSIGNMENT_FILE_MAX_COUNT, { limits: { files: ASSIGNMENT_FILE_MAX_COUNT, fileSize: ASSIGNMENT_FILE_MAX_SIZE_BYTES } }))
  @ApiOperation({ summary: 'Upload guarded files for an assignment' })
  addAssignmentFiles(
    @Param('assignmentId') assignmentId: string,
    @UploadedFiles() files: AssignmentUploadFile[] | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<Assignment> {
    return this.assignments.addAssignmentFiles(user, assignmentId, files ?? []);
  }

  @Get('assignments/:assignmentId/attachments/:attachmentId/download')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Download an authorized assignment attachment' })
  async downloadAssignmentAttachment(
    @Param('assignmentId') assignmentId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: HeaderResponse
  ): Promise<StreamableFile> {
    const download = await this.assignments.downloadAssignmentAttachment(user, assignmentId, attachmentId);
    response.setHeader('Content-Type', download.mimeType);
    response.setHeader('Content-Length', download.size);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Disposition', `inline; filename="${this.contentDispositionFileName(download.fileName)}"`);
    return new StreamableFile(download.stream);
  }

  @Get('assignments/:assignmentId/submissions')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'List submissions for an assignment' })
  listSubmissions(@Param('assignmentId') assignmentId: string, @CurrentUser() user: AuthenticatedUser): Promise<AssignmentSubmissionListResponse> {
    return this.assignments.listSubmissions(user, assignmentId);
  }

  @Patch('assignments/:assignmentId/submissions/:submissionId/review')
  @Roles('TEACHER', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Review, return, or complete a student submission' })
  reviewSubmission(
    @Param('assignmentId') assignmentId: string,
    @Param('submissionId') submissionId: string,
    @Body() body: ReviewAssignmentSubmissionRequest,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AssignmentSubmission> {
    return this.assignments.reviewSubmission(user, assignmentId, submissionId, body);
  }

  @Get('assignments/:assignmentId/submissions/:submissionId/attachments/:attachmentId/download')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Download an authorized submission file' })
  async downloadSubmissionAttachment(
    @Param('assignmentId') assignmentId: string,
    @Param('submissionId') submissionId: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: HeaderResponse
  ): Promise<StreamableFile> {
    const download = await this.assignments.downloadSubmissionAttachment(user, assignmentId, submissionId, attachmentId);
    response.setHeader('Content-Type', download.mimeType);
    response.setHeader('Content-Length', download.size);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Disposition', `inline; filename="${this.contentDispositionFileName(download.fileName)}"`);
    return new StreamableFile(download.stream);
  }

  @Get('student/assignments')
  @Roles('STUDENT')
  @ApiOperation({ summary: 'List assignments available to the current student' })
  listStudentAssignments(@Query() query: AssignmentListQuery, @CurrentUser() user: AuthenticatedUser): Promise<StudentAssignmentListResponse> {
    return this.assignments.listStudentAssignments(user, query);
  }

  @Get('student/assignments/:assignmentId')
  @Roles('STUDENT')
  @ApiOperation({ summary: 'Get one student assignment with own submission' })
  getStudentAssignment(@Param('assignmentId') assignmentId: string, @CurrentUser() user: AuthenticatedUser): Promise<AssignmentDetailResponse> {
    return this.assignments.getAssignment(user, assignmentId);
  }

  @Post('student/assignments/:assignmentId/viewed')
  @Roles('STUDENT')
  @ApiOperation({ summary: 'Mark an assignment viewed by the current student' })
  markViewed(@Param('assignmentId') assignmentId: string, @CurrentUser() user: AuthenticatedUser): Promise<AssignmentSubmission> {
    return this.assignments.markViewed(user, assignmentId);
  }

  @Post('student/assignments/:assignmentId/submission')
  @Roles('STUDENT')
  @UseInterceptors(FilesInterceptor('files', ASSIGNMENT_FILE_MAX_COUNT, { limits: { files: ASSIGNMENT_FILE_MAX_COUNT, fileSize: ASSIGNMENT_FILE_MAX_SIZE_BYTES } }))
  @ApiOperation({ summary: 'Submit assignment work for the current student' })
  submitAssignment(
    @Param('assignmentId') assignmentId: string,
    @Body() body: SubmitAssignmentRequest & { linksJson?: string },
    @UploadedFiles() files: AssignmentUploadFile[] | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AssignmentSubmission> {
    const request = this.parseSubmissionBody(body);
    return this.assignments.submitAssignment(user, assignmentId, request, files ?? []);
  }

  @Patch('student/assignments/:assignmentId/submission')
  @Roles('STUDENT')
  @UseInterceptors(FilesInterceptor('files', ASSIGNMENT_FILE_MAX_COUNT, { limits: { files: ASSIGNMENT_FILE_MAX_COUNT, fileSize: ASSIGNMENT_FILE_MAX_SIZE_BYTES } }))
  @ApiOperation({ summary: 'Revise assignment work for the current student' })
  reviseAssignment(
    @Param('assignmentId') assignmentId: string,
    @Body() body: SubmitAssignmentRequest & { linksJson?: string },
    @UploadedFiles() files: AssignmentUploadFile[] | undefined,
    @CurrentUser() user: AuthenticatedUser
  ): Promise<AssignmentSubmission> {
    const request = this.parseSubmissionBody(body);
    return this.assignments.submitAssignment(user, assignmentId, request, files ?? []);
  }

  private parseSubmissionBody(body: SubmitAssignmentRequest & { linksJson?: string }): SubmitAssignmentRequest {
    if (body.linksJson && !body.links) {
      try {
        return { ...body, links: JSON.parse(body.linksJson) as SubmitAssignmentRequest['links'] };
      } catch {
        return { ...body, links: [] };
      }
    }
    return body;
  }

  private contentDispositionFileName(fileName: string): string {
    return fileName.replace(/["\\\r\n]/g, '_');
  }
}
