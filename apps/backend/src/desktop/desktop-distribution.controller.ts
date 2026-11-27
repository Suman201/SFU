import { Controller, Get, Header } from '@nestjs/common';
import { DesktopDistributionService } from './desktop-distribution.service';
@Controller({ path: 'desktop/releases', version: '1' })
export class DesktopDistributionController {
  constructor(private readonly distribution: DesktopDistributionService) {}
  @Get() @Header('Cache-Control', 'no-store')
  catalogue() { return this.distribution.catalogue(); }
}
