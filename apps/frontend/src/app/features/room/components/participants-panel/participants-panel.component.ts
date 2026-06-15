import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { Participant, Role } from '@native-sfu/contracts';

@Component({
  selector: 'sfu-participants-panel',
  standalone: true,
  template: `
    <aside class="participants">
      <header>
        <h2>Participants</h2>
        <span>{{ participants.length }}</span>
      </header>
      <div class="list">
        @for (participant of participants; track participant.id) {
          <article>
            <div>
              <strong>{{ participant.displayName }}</strong>
              <span>{{ participant.role }}</span>
            </div>
            <div class="toolbar">
              <button class="icon-button" type="button" title="Mute" (click)="mute.emit(participant.id)" [disabled]="participant.id === localParticipantId">M</button>
              <button class="icon-button danger" type="button" title="Kick" (click)="kick.emit(participant.id)" [disabled]="participant.id === localParticipantId">K</button>
            </div>
          </article>
        }
      </div>
    </aside>
  `,
  styles: [
    `
      .participants {
        display: grid;
        gap: 10px;
      }

      header,
      article {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
      }

      h2 {
        margin: 0;
      }

      .list {
        display: grid;
        gap: 8px;
      }

      article {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 10px;
      }

      strong,
      span {
        display: block;
      }

      span {
        color: var(--muted);
        font-size: 12px;
      }
    `
  ]
})
export class ParticipantsPanelComponent {
  @Input() participants: Participant[] = [];
  @Input() localParticipantId: string | null = null;
  @Output() mute = new EventEmitter<string>();
  @Output() kick = new EventEmitter<string>();
}
