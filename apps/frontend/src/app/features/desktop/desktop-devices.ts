import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DeviceSetupComponent } from '../../shared/device-setup/device-setup';

@Component({
  selector: 'sfu-desktop-devices', standalone: true, imports: [DeviceSetupComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush, styleUrl: './desktop.scss',
  template: `<section aria-labelledby="device-setup-title"><div class="page-heading"><div><p class="eyebrow">READY FOR CLASS</p><h1 id="device-setup-title">Device setup</h1><p class="muted">Microphone, speakers, and webcam.</p></div><a class="secondary" routerLink="/desktop/settings">Back to settings</a></div><sfu-device-setup /></section>`
})
export class DesktopDevices {}
