import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Injector,
  ViewChild,
  effect,
  inject,
} from '@angular/core';
import { ConfirmDialogService } from './confirm-dialog.service';

@Component({
  selector: 'sfu-admin-confirm-dialog',
  standalone: true,
  template: `
    @if (dialog(); as current) {
      <section
        class="confirm-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-confirm-title"
        aria-describedby="admin-confirm-message"
        (click)="cancel()"
      >
        <article
          class="confirm-modal"
          tabindex="-1"
          [class.danger]="current.variant === 'danger'"
          [class.warning]="current.variant === 'warning'"
          (click)="$event.stopPropagation()"
        >
          <header>
            <span class="confirm-mark" aria-hidden="true"></span>
            <div>
              <p>Confirm action</p>
              <h2 id="admin-confirm-title">{{ current.title }}</h2>
            </div>
          </header>
          <p id="admin-confirm-message">{{ current.message }}</p>
          <footer>
            <button
              #cancelButton
              class="confirm-button secondary"
              type="button"
              [disabled]="current.pending"
              (click)="cancel()"
            >
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
              {{
                current.pending ? current.pendingLabel : current.confirmLabel
              }}
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
        padding: max(18px, env(safe-area-inset-top))
          max(14px, env(safe-area-inset-right))
          max(18px, env(safe-area-inset-bottom))
          max(14px, env(safe-area-inset-left));
        background: color-mix(in srgb, #07110e 56%, transparent);
      }

      .confirm-modal {
        width: min(420px, 100%);
        display: grid;
        gap: 16px;
        padding: 18px;
        border: 1px solid
          color-mix(in srgb, var(--product-green) 22%, var(--line));
        border-radius: 8px;
        background: var(--panel-elevated);
        color: var(--text);
        box-shadow: var(--shadow-lg);
      }

      .confirm-modal.warning {
        border-color: color-mix(in srgb, var(--product-amber) 48%, var(--line));
      }

      .confirm-modal.danger {
        border-color: color-mix(in srgb, var(--product-rose) 48%, var(--line));
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
        font-weight: 600;
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
        background: color-mix(in srgb, var(--product-green) 14%, transparent);
      }

      .confirm-mark::before {
        content: '!';
        color: var(--green-ink);
        font-weight: 600;
      }

      .warning .confirm-mark {
        background: color-mix(in srgb, var(--product-amber) 22%, transparent);
      }

      .warning .confirm-mark::before {
        color: color-mix(in srgb, var(--product-amber) 72%, #8a5a00);
      }

      .danger .confirm-mark {
        background: color-mix(in srgb, var(--product-rose) 18%, transparent);
      }

      .danger .confirm-mark::before {
        color: var(--rose-ink);
      }

      .confirm-button {
        min-height: 38px;
        border-radius: 5px;
        padding: 0 14px;
        font-weight: 600;
      }

      .confirm-button.secondary {
        background: var(--panel);
      }

      .confirm-button.primary {
        border-color: var(--action);
        background: var(--action);
        color: var(--bg);
      }

      .confirm-button.primary.warning {
        border-color: var(--product-amber);
        background: color-mix(in srgb, var(--product-amber) 82%, #9b6200);
      }

      .confirm-button.primary.danger {
        border-color: var(--rose-ink);
        background: var(--product-rose);
        color: #29131a;
      }

      @media (max-width: 520px) {
        .confirm-backdrop {
          place-items: end center;
        }

        .confirm-modal {
          border-radius: 8px 14px 0 0;
        }

        footer {
          display: grid;
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class ConfirmDialogComponent {
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly injector = inject(Injector);
  private lastDialogId: number | null = null;
  private returnFocus: HTMLElement | null = null;

  protected readonly dialog = this.confirmDialog.dialog;

  @ViewChild('cancelButton')
  private readonly cancelButton?: ElementRef<HTMLButtonElement>;

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
      this.returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      afterNextRender(() => this.cancelButton?.nativeElement.focus(), {
        injector: this.injector,
      });
    });
  }

  @HostListener('document:keydown', ['$event'])
  protected trapFocus(event: KeyboardEvent): void {
    if (!this.dialog() || event.key !== 'Tab') return;
    const modal =
      this.host.nativeElement.querySelector<HTMLElement>('.confirm-modal');
    const buttons = Array.from(
      modal?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ??
        [],
    );
    const first = buttons[0],
      last = buttons[buttons.length - 1];
    if (!first) {
      event.preventDefault();
      modal?.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
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
    afterNextRender(() => target?.focus(), { injector: this.injector });
  }
}
