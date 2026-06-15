import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'sfu-host-controls',
  standalone: true,
  template: `
    <section class="host">
      <button type="button" (click)="lock.emit()" [disabled]="!isHost">Lock</button>
      <button type="button" (click)="unlock.emit()" [disabled]="!isHost">Unlock</button>
      <button type="button" class="danger" (click)="close.emit()" [disabled]="!isHost">End</button>
    </section>
  `,
  styles: [
    `
      .host {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
    `
  ]
})
export class HostControlsComponent {
  @Input() isHost = false;
  @Output() lock = new EventEmitter<void>();
  @Output() unlock = new EventEmitter<void>();
  @Output() close = new EventEmitter<void>();
}
