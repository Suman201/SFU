import { Component, Input, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'sfu-network-indicator',
  standalone: true,
  template: `
    <div class="network" [attr.aria-label]="'Network score ' + score">
      @for (bar of bars; track bar) {
        <span [class.on]="bar <= score"></span>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .network {
        display: inline-flex;
        align-items: end;
        gap: 3px;
        height: 20px;
      }

      span {
        width: 5px;
        border-radius: 2px;
        background: var(--line-strong);
      }

      span:nth-child(1) {
        height: 7px;
      }

      span:nth-child(2) {
        height: 10px;
      }

      span:nth-child(3) {
        height: 13px;
      }

      span:nth-child(4) {
        height: 16px;
      }

      span:nth-child(5) {
        height: 19px;
      }

      span.on {
        background: var(--accent);
      }
    `
  ]
})
export class NetworkIndicatorComponent {
  @Input() score = 5;
  readonly bars = [1, 2, 3, 4, 5];
}
