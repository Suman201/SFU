import { Component, EventEmitter, Input, Output, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'sfu-recording-controls',
  standalone: true,
  template: `
    <section class="recording">
      <button type="button" (click)="start.emit()" [disabled]="recording || !isHost">Record</button>
      <button type="button" (click)="stop.emit()" [disabled]="!recording || !isHost">Stop</button>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .recording {
        display: flex;
        gap: 8px;
      }
    `
  ]
})
export class RecordingControlsComponent {
  @Input() isHost = false;
  @Input() recording = false;
  @Output() start = new EventEmitter<void>();
  @Output() stop = new EventEmitter<void>();
}
