import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { ChatMessage, Participant } from '@native-sfu/contracts';

@Component({
  selector: 'sfu-chat-panel',
  standalone: true,
  imports: [FormsModule],
  template: `
    <aside class="chat">
      <header>
        <h2>Chat</h2>
      </header>
      <div class="messages">
        @for (message of messages; track message.id) {
          <article>
            <strong>{{ nameFor(message.senderId) }}</strong>
            <p>{{ message.message }}</p>
          </article>
        }
      </div>
      <form (ngSubmit)="submit()">
        <textarea name="message" [(ngModel)]="draft" rows="3" maxlength="4000"></textarea>
        <button class="primary" type="submit" [disabled]="!draft.trim()">Send</button>
      </form>
    </aside>
  `,
  styles: [
    `
      .chat {
        height: 100%;
        min-height: 320px;
        display: grid;
        grid-template-rows: auto 1fr auto;
        gap: 10px;
      }

      h2,
      p {
        margin: 0;
      }

      .messages {
        min-height: 0;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      article {
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 8px;
        background: var(--panel);
      }

      strong {
        display: block;
        font-size: 12px;
        color: var(--accent);
      }

      p {
        font-size: 13px;
        line-height: 1.45;
      }

      form {
        display: grid;
        gap: 8px;
      }
    `
  ]
})
export class ChatPanelComponent {
  @Input() messages: ChatMessage[] = [];
  @Input() participants: Participant[] = [];
  @Output() sendMessage = new EventEmitter<string>();
  draft = '';

  submit(): void {
    const value = this.draft.trim();
    if (!value) {
      return;
    }
    this.sendMessage.emit(value);
    this.draft = '';
  }

  nameFor(participantId: string): string {
    return this.participants.find((participant) => participant.id === participantId)?.displayName ?? 'Participant';
  }
}
