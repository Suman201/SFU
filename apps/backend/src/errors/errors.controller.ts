import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ErrorsService } from './errors.service';
import { ListErrorsDto, ReportErrorDto, UpdateErrorDto } from './errors.dto';
@Controller('errors')
@UseGuards(JwtAuthGuard)
export class ErrorsController {
  constructor(private readonly errors: ErrorsService) {}
  @Post('reports')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  report(
    @Body() input: ReportErrorDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.errors.report(input, user.sub);
  }
}
@Controller('admin/errors')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class AdminErrorsController {
  constructor(private readonly errors: ErrorsService) {}
  @Header('Cache-Control', 'no-store')
  @Get()
  list(@Query() query: ListErrorsDto) {
    return this.errors.list(query);
  }
  @Header('Cache-Control', 'no-store')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.errors.get(id);
  }
  @Header('Cache-Control', 'no-store')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() input: UpdateErrorDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.errors.update(id, input.status, user.sub);
  }
}
