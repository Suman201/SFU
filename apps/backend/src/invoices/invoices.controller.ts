import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../common/decorators/current-user.decorator';
import { InvoicesService } from './invoices.service';
import {
  InvoiceEmailDto,
  InvoicePaymentDto,
  InvoiceSettingsDto,
  InvoiceVersionDto,
  InvoiceVoidDto,
  InvoiceWriteDto,
} from './invoice.dto';
@Controller('admin/invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}
  @Get('settings') settings() {
    return this.service.settings();
  }
  @Patch('settings') saveSettings(
    @Body() input: InvoiceSettingsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.saveSettings(input, actor);
  }
  @Get() list(@Query() query: Record<string, string>) {
    return this.service.list(query);
  }
  @Post() create(
    @Body() input: InvoiceWriteDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.create(input, actor);
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.service.get(id);
  }
  @Patch(':id') update(
    @Param('id') id: string,
    @Body() input: InvoiceWriteDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.update(id, input, actor);
  }
  @Post(':id/issue') issue(
    @Param('id') id: string,
    @Body() input: InvoiceVersionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.issue(id, input.version, actor);
  }
  @Post(':id/payment') paid(
    @Param('id') id: string,
    @Body() input: InvoicePaymentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.paid(id, input, actor);
  }
  @Post(':id/void') void(
    @Param('id') id: string,
    @Body() input: InvoiceVoidDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.void(id, input, actor);
  }
  @Post(':id/email') send(
    @Param('id') id: string,
    @Body() input: InvoiceEmailDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.send(id, input.requestId, actor);
  }
  @Get(':id/pdf') async pdf(
    @Param('id') id: string,
    @Res({ passthrough: true })
    res: { setHeader: (key: string, value: string) => void },
  ) {
    const pdf = await this.service.pdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pdf.name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(pdf.bytes);
  }
}
