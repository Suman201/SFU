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
  CurrentUser,
  AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { CalendarService } from './calendar.service';
import { ClassCommunicationsService } from './class-communications.service';
import {
  CalendarChangeDto,
  CalendarPreferenceDto,
  CalendarRangeDto,
} from './calendar.dto';
@Controller('calendar')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER', 'STUDENT')
export class CalendarController {
  constructor(
    private readonly calendar: CalendarService,
    private readonly communications: ClassCommunicationsService,
  ) {}
  @Get('classes') list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() range: CalendarRangeDto,
  ) {
    return this.calendar.list(user, range.from, range.to);
  }
  @Patch('batches/:batchId/classes/:id') @Roles('TEACHER') change(
    @CurrentUser() user: AuthenticatedUser,
    @Param('batchId') batch: string,
    @Param('id') id: string,
    @Body() body: CalendarChangeDto,
  ) {
    return this.calendar.change(user, batch, id, body);
  }
  @Get('notices') notices(@CurrentUser() user: AuthenticatedUser) {
    return this.communications.list(user.sub);
  }
  @Post('notices/:id/read') read(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.communications.markRead(user.sub, id);
  }
  @Get('preferences') async preference(@CurrentUser() user: AuthenticatedUser) {
    return {
      timeZone: (await this.calendar.users.findById(user.sub))?.timezone,
    };
  }
  @Patch('preferences') async savePreference(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CalendarPreferenceDto,
  ) {
    await this.calendar.users.updateOne(
      { _id: user.sub },
      { $set: { timezone: body.timeZone } },
    );
    return body;
  }
}
