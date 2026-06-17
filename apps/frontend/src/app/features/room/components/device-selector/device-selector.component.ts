import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';
import type { DeviceOption } from '../../../../core/services/webrtc.service';

@Component({
  selector: 'sfu-device-selector',
  standalone: true,
  template: `
    <div class="device-selector">
      <label>
        Microphone
        <select [value]="audioDeviceId" (change)="audioDeviceIdChange.emit($any($event.target).value)">
          @for (device of audioInputs; track device.id) {
            <option [value]="device.id">{{ device.label }}</option>
          }
        </select>
      </label>
      <label>
        Camera
        <select [value]="videoDeviceId" (change)="videoDeviceIdChange.emit($any($event.target).value)">
          @for (device of videoInputs; track device.id) {
            <option [value]="device.id">{{ device.label }}</option>
          }
        </select>
      </label>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .device-selector {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }

      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 12px;
      }

      @media (max-width: 760px) {
        .device-selector {
          grid-template-columns: 1fr;
        }
      }
    `
  ]
})
export class DeviceSelectorComponent {
  @Input() audioInputs: DeviceOption[] = [];
  @Input() videoInputs: DeviceOption[] = [];
  @Input() audioDeviceId = '';
  @Input() videoDeviceId = '';
  @Output() audioDeviceIdChange = new EventEmitter<string>();
  @Output() videoDeviceIdChange = new EventEmitter<string>();
}
