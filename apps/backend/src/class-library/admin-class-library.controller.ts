import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ClassLibrarySearchQuery, ClassLibrarySearchResponse } from '@native-sfu/contracts';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ClassLibraryService } from './class-library.service';

@ApiTags('admin class library')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/class-library')
export class AdminClassLibraryController {
  constructor(private readonly classLibrary: ClassLibraryService) {}

  @Get('search')
  @Roles('ADMIN', 'SUPER_ADMIN')
  @ApiOperation({ summary: 'Search class-session learning artifacts as an administrator' })
  search(@Query() query: ClassLibrarySearchQuery, @CurrentUser() user: AuthenticatedUser): Promise<ClassLibrarySearchResponse> {
    return this.classLibrary.search(query, user, { adminOnly: true });
  }
}
