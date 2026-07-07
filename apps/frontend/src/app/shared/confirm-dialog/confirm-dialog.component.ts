import { ChangeDetectionStrategy, Component, ElementRef, HostListener, ViewChild, effect, inject } from '@angular/core';
import { ConfirmDialogService } from './confirm-dialog.service';

@Component({
  selector: 'sfu-confirm-dialog',
  standalone: true,
  template: `
    @if (dialog(); as current) {
      <section
        class="confirm-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-confirm-title"
        aria-describedby="app-confirm-message"
        (click)="cancel()"
      >
        <article class="confirm-modal" [class.danger]="current.variant === 'danger'" [class.warning]="current.variant === 'warning'" (click)="$event.stopPropagation()">
          <header>
            <span class="confirm-mark" aria-hidden="true"></span>
            <div>
              <p>Confirm action</p>
              <h2 id="app-confirm-title">{{ current.title }}</h2>
            </div>
          </header>
          <p id="app-confirm-message">{{ current.message }}</p>
          <footer>
            <button #cancelButton class="confirm-button secondary" type="button" [disabled]="current.pending" (click)="cancel()">
              {{ current.cancelLabel }}
            </button>
            <button
              class="confirm-button primary"
              type="button"
              [class.danger]="current.variant === 'danger'"
              [class.warning]="current.variant === 'warning'"
              [disabled]="current.pending"
              (click)="accept()"
            >
              {{ current.pending ? current.pendingLabel : current.confirmLabel }}
            </button>
          </footer>
        </article>
      </section>
    }
  `,
  styles: [
    `
      .confirm-backdrop {
        position: fixed;
        inset: 0;
        z-index: 5000;
        display: grid;
        place-items: center;
        padding: max(18px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom))
          max(14px, env(safe-area-inset-left));
        background: color-mix(in srgb, #041128 58%, transparent);
        backdrop-filter: blur(12px);
      }

      .confirm-modal {
        width: min(420px, 100%);
        display: grid;
        gap: 16px;
        padding: 18px;
        border: 1px solid color-mix(in srgb, var(--success) 24%, var(--line));
        border-radius: 14px;
        background: var(--panel-elevated);
        color: var(--text);
        box-shadow: var(--shadow-md);
      }

      .confirm-modal.warning {
        border-color: color-mix(in srgb, var(--brand-amber) 48%, var(--line));
      }

      .confirm-modal.danger {
        border-color: color-mix(in srgb, var(--brand-rose) 48%, var(--line));
      }

      header,
      footer {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      header {
        align-items: flex-start;
      }

      h2,
      p {
        margin: 0;
      }

      header p {
        color: var(--muted);
        font-size: 11px;
        font-weight: 900;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      h2 {
        margin-top: 2px;
        font-size: 18px;
        letter-spacing: 0;
      }

      .confirm-modal > p {
        color: var(--muted);
        font-size: 14px;
        line-height: 1.5;
      }

      footer {
        justify-content: flex-end;
        flex-wrap: wrap;
      }

      .confirm-mark {
        width: 34px;
        height: 34px;
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        border-radius: 999px;
        background: color-mix(in srgb, var(--success) 14%, transparent);
      }

      .confirm-mark::before {
        content: '!';
        color: var(--success);
        font-weight: 900;
      }

      .warning .confirm-mark {
        background: color-mix(in srgb, var(--brand-amber) 22%, transparent);
      }

      .warning .confirm-mark::before {
        color: var(--brand-amber-strong);
      }

      .danger .confirm-mark {
        background: color-mix(in srgb, var(--brand-rose) 18%, transparent);
      }

      .danger .confirm-mark::before {
        color: var(--brand-rose);
      }

      .confirm-button {
        min-height: 38px;
        border-radius: var(--radius);
        padding: 0 14px;
        font-weight: 900;
      }

      .confirm-button.primary {
        border-color: var(--success);
        background: var(--success);
        color: #fff;
      }

      .confirm-button.primary.warning {
        border-color: var(--brand-amber);
        background: var(--brand-amber-strong);
      }

      .confirm-button.primary.danger {
        border-color: var(--brand-rose);
        background: var(--brand-rose);
      }

      @media (max-width: 520px) {
        .confirm-backdrop {
          place-items: end center;
        }

        .confirm-modal {
          border-radius: 14px 14px 0 0;
        }

        footer {
          display: grid;
          grid-template-columns: 1fr;
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.Eager
})
export class ConfirmDialogComponent {
  private readonly confirmDialog = inject(ConfirmDialogService);
  private lastDialogId: number | null = null;
  private returnFocus: HTMLElement | null = null;

  protected readonly dialog = this.confirmDialog.dialog;

  @ViewChild('cancelButton') private readonly cancelButton?: ElementRef<HTMLButtonElement>;

  constructor() {
    effect(() => {
      const dialog = this.dialog();
      if (!dialog) {
        this.restoreFocus();
        this.lastDialogId = null;
        return;
      }
      if (dialog.id === this.lastDialogId) {
        return;
      }
      this.lastDialogId = dialog.id;
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      queueMicrotask(() => this.cancelButton?.nativeElement.focus());
    });
  }

  @HostListener('document:keydown.escape')
  protected cancel(): void {
    this.confirmDialog.cancel();
  }

  protected accept(): void {
    this.confirmDialog.accept();
  }

  private restoreFocus(): void {
    const target = this.returnFocus;
    this.returnFocus = null;
    queueMicrotask(() => target?.focus());
  }
}
