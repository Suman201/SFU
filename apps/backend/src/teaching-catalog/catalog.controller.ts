import { OnboardingReadinessService } from './onboarding-readiness.service';
import { TutorNoticesService } from './tutor-notices.service';
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../common/decorators/current-user.decorator';
import { TeachingCatalogService } from './catalog.service';
import { TutorApplicationsService } from './applications.service';
import {
  CatalogWriteDto,
  ReviewTutorDto,
  SubmitTutorDto,
  ApproveAssessmentContentDto,
} from './catalog.dto';
@Controller('teaching-catalog')
export class TeachingCatalogController {
  constructor(private readonly catalog: TeachingCatalogService) {}
  @Get() async list() {
    const snapshot = await this.catalog.snapshot();
    const redact = (
      entry: import('@native-sfu/contracts').TeachingCatalogEntry,
    ) => {
      const { assessmentApproval, ...safe } = entry;
      return {
        ...safe,
        ...(assessmentApproval
          ? { assessmentApprovedVersion: assessmentApproval.version }
          : {}),
      };
    };
    return {
      ...snapshot,
      categories: snapshot.categories.map(redact),
      levels: snapshot.levels?.map(redact),
    };
  }
}
@Controller('admin/teaching-catalog')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminTeachingCatalogController {
  constructor(private readonly catalog: TeachingCatalogService) {}
  @Get() list(@Query() query: Record<string, string>) {
    return this.catalog.list(query);
  }
  @Post('starter') starter(@CurrentUser() actor: AuthenticatedUser) {
    return this.catalog.starter(actor);
  }
  @Post(':kind/:id/assessment-approval') approveContent(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() input: ApproveAssessmentContentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.approveAssessmentContent(kind, id, input, actor);
  }
  @Post(':kind') create(
    @Param('kind') kind: string,
    @Body() input: CatalogWriteDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.write(kind, null, input, actor);
  }
  @Patch(':kind/:id') update(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() input: CatalogWriteDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.catalog.write(kind, id, input, actor);
  }
}
@Controller('tutor-application')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER')
export class TutorApplicationController {
  constructor(
    private readonly applications: TutorApplicationsService,
    private readonly notices: TutorNoticesService,
  ) {}
  @Get('notices') noticesList(@CurrentUser() actor: AuthenticatedUser) {
    return this.notices.list(actor.sub);
  }
  @Post('notices/:noticeId/read') noticeRead(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('noticeId') id: string,
  ) {
    return this.notices.read(actor.sub, id);
  }
  @Get('me') mine(@CurrentUser() actor: AuthenticatedUser) {
    return this.applications.mine(actor);
  }
  @Post('submit') submit(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: SubmitTutorDto,
  ) {
    return this.applications.submit(actor, input);
  }
}
@Controller('admin/tutor-applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminTutorApplicationsController {
  constructor(private readonly applications: TutorApplicationsService) {}
  @Get() list(@Query('status') status: string, @Query('page') page: string) {
    return this.applications.list(status || 'submitted', Number(page || 1));
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.applications.get(id);
  }
  @Post(':id/review') review(
    @Param('id') id: string,
    @Body() input: ReviewTutorDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.applications.review(id, input, actor);
  }
}

@Controller('admin/tutor-onboarding')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class TutorOnboardingReadinessController {
  constructor(private readonly readiness: OnboardingReadinessService) {}
  @Get('readiness') check() {
    return this.readiness.check();
  }
}
