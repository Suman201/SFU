import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { Participant } from '@native-sfu/contracts';

@Component({
  selector: 'sfu-waiting-room',
  standalone: true,
  template: `
    @if (pending.length) {
      <section class="waiting">
        <h2>Waiting room</h2>
        @for (participant of pending; track participant.id) {
          <article>
            <span>{{ participant.displayName }}</span>
            <div class="toolbar">
              <button type="button" (click)="admit.emit(participant.id)">Admit</button>
              <button class="danger" type="button" (click)="reject.emit(participant.id)">Reject</button>
            </div>
          </article>
        }
      </section>
    }
  `,
  styles: [
    `
      .waiting,
      article {
        display: grid;
        gap: 8px;
      }

      h2 {
        margin: 0;
      }

      article {
        grid-template-columns: 1fr auto;
        align-items: center;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--panel);
        padding: 10px;
      }
    `
  ]
})
export class WaitingRoomComponent {
  @Input() pending: Participant[] = [];
  @Output() admit = new EventEmitter<string>();
  @Output() reject = new EventEmitter<string>();
}
