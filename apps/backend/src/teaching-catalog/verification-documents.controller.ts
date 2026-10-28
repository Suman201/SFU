import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Body,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import {
  VerificationDocumentsService,
  VERIFICATION_MAX_BYTES,
} from './verification-documents.service';
import { ReviewVerificationDocumentDto } from './catalog.dto';
interface Response {
  setHeader(name: string, value: string | number): void;
}
async function download(
  service: VerificationDocumentsService,
  actor: AuthenticatedUser,
  teacherId: string,
  id: string,
  response: Response,
) {
  const document = await service.read(actor, teacherId, id);
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Type', document.mimeType);
  response.setHeader('Content-Length', document.bytes.length);
  const extension =
    document.mimeType === 'application/pdf'
      ? 'pdf'
      : document.mimeType === 'image/png'
        ? 'png'
        : 'jpg';
  response.setHeader(
    'Content-Disposition',
    `attachment; filename="verification-${id}.${extension}"`,
  );
  return new StreamableFile(document.bytes);
}
@Controller('tutor-application/me/verification-documents')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER')
export class TutorVerificationDocumentsController {
  constructor(private readonly documents: VerificationDocumentsService) {}
  @Post(':kind')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: VERIFICATION_MAX_BYTES },
    }),
  )
  upload(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('kind') kind: string,
    @UploadedFile() file: any,
  ) {
    return this.documents.upload(actor, kind, file);
  }
  @Get(':documentId') read(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('documentId') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return download(this.documents, actor, actor.sub, id, response);
  }
  @Delete(':documentId') remove(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('documentId') id: string,
  ) {
    return this.documents.remove(actor, id);
  }
}
@Controller('admin/tutor-applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminTutorVerificationDocumentsController {
  constructor(private readonly documents: VerificationDocumentsService) {}
  @Get(':id/verification-documents/:documentId') read(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') teacherId: string,
    @Param('documentId') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    return download(this.documents, actor, teacherId, id, response);
  }
  @Post(':id/verification-documents/:documentId/review') review(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') teacherId: string,
    @Param('documentId') id: string,
    @Body() input: ReviewVerificationDocumentDto,
  ) {
    return this.documents.review(
      actor,
      teacherId,
      id,
      input.decision,
      input.note,
    );
  }
}
