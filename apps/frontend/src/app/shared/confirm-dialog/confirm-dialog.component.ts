import { isDialogBackdropClick } from './dialog-backdrop';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { ConfirmDialogService } from './confirm-dialog.service';

@Component({
  selector: 'sfu-confirm-dialog',
  standalone: true,
  template: `
    <dialog
      #modal
      class="sfu-dialog confirm-modal"
      aria-labelledby="app-confirm-title"
      aria-describedby="app-confirm-message"
      (cancel)="$event.preventDefault(); cancel()"
      (click)="isBackdropClick($event) ? cancel() : null"
    >
      @if (dialog(); as current) {
        <header>
          <span
            class="confirm-mark"
            [class]="current.variant"
            aria-hidden="true"
            >!</span
          >
          <h2 id="app-confirm-title">{{ current.title }}</h2>
        </header>
        <p id="app-confirm-message">{{ current.message }}</p>
        <footer>
          <button
            #cancelButton
            type="button"
            [disabled]="current.pending"
            (click)="cancel()"
          >
            {{ current.cancelLabel }}
          </button>
          <button
            class="confirm-action"
            type="button"
            [class.danger]="current.variant === 'danger'"
            [class.warning]="current.variant === 'warning'"
            [disabled]="current.pending"
            (click)="accept()"
          >
            {{ current.pending ? current.pendingLabel : current.confirmLabel }}
          </button>
        </footer>
      }
    </dialog>
  `,
  styles: [
    `
      .confirm-modal {
        --dialog-width: 440px;
      }
      header {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      h2 {
        margin: 0;
        font-size: 20px;
        line-height: 1.25;
        letter-spacing: -0.02em;
      }
      p {
        margin: 14px 0 20px;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.55;
      }
      .confirm-mark {
        flex: 0 0 32px;
        height: 32px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: var(--success-soft, var(--green-soft));
        color: var(--success-ink, var(--green-ink));
        font-weight: 700;
      }
      .confirm-mark.warning {
        background: color-mix(
          in srgb,
          var(--dialog-warning-bg) 18%,
          transparent
        );
        color: var(--dialog-warning-text);
      }
      .confirm-mark.danger {
        background: var(--feedback-error-bg);
        color: var(--feedback-error);
      }
      footer {
        display: flex;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 8px;
      }
      button {
        min-height: 40px;
        padding: 8px 14px;
        border: 1px solid var(--line);
        border-radius: var(--radius, 8px);
        background: var(--panel);
        color: var(--text);
        font-size: 13px;
        font-weight: 650;
      }
      .confirm-action {
        border-color: transparent;
        background: var(--dialog-action-bg);
        color: var(--dialog-action-text);
      }
      .confirm-action.warning {
        background: var(--dialog-warning-bg);
        color: #2f2107;
      }
      .confirm-action.danger {
        background: var(--dialog-danger-bg);
        color: var(--dialog-danger-text);
      }
      button:hover:not(:disabled) {
        border-color: var(--focus-ring, var(--focus));
      }
      @media (max-width: 420px) {
        footer > button {
          flex: 1 1 auto;
          min-height: 44px;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialogComponent {
  protected readonly isBackdropClick = isDialogBackdropClick;
  private readonly service = inject(ConfirmDialogService);
  private readonly injector = inject(Injector);
  private readonly modal = viewChild<ElementRef<HTMLDialogElement>>('modal');
  private readonly cancelButton =
    viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  protected readonly dialog = this.service.dialog;

  constructor() {
    effect(() => {
      const state = this.dialog();
      const modal = this.modal()?.nativeElement;
      if (!modal) return;
      if (!state) {
        if (modal.open) modal.close();
        return;
      }
      if (modal.open) return;
      afterNextRender(
        () => {
          if (this.dialog() && modal.isConnected && !modal.open) {
            modal.showModal();
            this.cancelButton()?.nativeElement.focus();
          }
        },
        { injector: this.injector },
      );
    });
  }

  protected cancel(): void {
    this.service.cancel();
  }

  protected accept(): void {
    this.service.accept();
  }
}
