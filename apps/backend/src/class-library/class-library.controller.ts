import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ClassLibrarySearchQuery, ClassLibrarySearchResponse } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ClassLibraryService } from './class-library.service';

@ApiTags('class library')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('class-library')
export class ClassLibraryController {
  constructor(private readonly classLibrary: ClassLibraryService) {}

  @Get('search')
  @Roles('TEACHER', 'STUDENT', 'ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Search authorized class-session learning artifacts' })
  search(@Query() query: ClassLibrarySearchQuery, @CurrentUser() user: AuthenticatedUser): Promise<ClassLibrarySearchResponse> {
    return this.classLibrary.search(query, user);
  }
}
