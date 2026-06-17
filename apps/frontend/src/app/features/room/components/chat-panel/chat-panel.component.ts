import { Component, EventEmitter, Input, Output, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormField, FormRoot, form as signalForm, maxLength } from '@angular/forms/signals';
import type { ChatMessage, Participant } from '@native-sfu/contracts';

interface ChatDraftFormModel {
  message: string;
}

@Component({
  selector: 'sfu-chat-panel',
  standalone: true,
  imports: [FormField, FormRoot],
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
      <form [formRoot]="draftForm" (submit)="submit($event)">
        <textarea [formField]="draftForm.message" rows="3"></textarea>
        <button class="primary" type="submit" [disabled]="!draftModel().message.trim() || draftForm().invalid()">Send</button>
      </form>
    </aside>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
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
  protected readonly draftModel = signal<ChatDraftFormModel>({ message: '' });
  protected readonly draftForm = signalForm(this.draftModel, (path) => {
    maxLength(path.message, 4000);
  });

  protected submit(event?: Event): void {
    event?.preventDefault();
    this.draftForm().markAsTouched();

    const value = this.draftModel().message.trim();
    if (!value || this.draftForm().invalid()) {
      return;
    }

    this.sendMessage.emit(value);
    this.draftModel.set({ message: '' });
    this.draftForm().reset();
  }

  nameFor(participantId: string): string {
    return this.participants.find((participant) => participant.id === participantId)?.displayName ?? 'Participant';
  }
}
