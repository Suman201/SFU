import {
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { GoogleCalendarService } from './google-calendar.service';
@Controller('calendar/google')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER')
export class GoogleCalendarController {
  constructor(private readonly google: GoogleCalendarService) {}
  @Get() status(@CurrentUser() user: AuthenticatedUser) {
    return this.google.status(user.sub);
  }
  @Post('connect') connect(@CurrentUser() user: AuthenticatedUser) {
    return this.google.connect(user.sub);
  }
  @Post('sync') sync(@CurrentUser() user: AuthenticatedUser) {
    return this.google.requestSync(user.sub);
  }
  @Delete() disconnect(@CurrentUser() user: AuthenticatedUser) {
    return this.google.disconnect(user.sub);
  }
}
@Controller('calendar/google')
export class GoogleCalendarCallbackController {
  constructor(private readonly google: GoogleCalendarService) {}
  @Get('callback') async callback(
    @Query('state') state: string | undefined,
    @Query('code') code: string | undefined,
    @Query('error') denied: string | undefined,
    @Res() response: Response,
  ) {
    let success = false;
    try {
      success = await this.google.callback(state, code, Boolean(denied));
    } catch {
      /* Provider error text never reaches the browser. */
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    response
      .status(success ? 200 : 400)
      .type('html')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sapiovian · Google Calendar</title><body><main><h1>${success ? 'Google Calendar connected' : 'Google Calendar could not connect'}</h1><p>${success ? 'Your classes will appear in a separate Sapiovian classes calendar.' : 'The request was cancelled or expired. You can try connecting again.'}</p><p>You can close this tab and return to Sapiovian.</p></main></body></html>`,
      );
  }
}
