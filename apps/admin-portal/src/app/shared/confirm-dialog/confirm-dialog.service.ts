import { Injectable, signal } from '@angular/core';

export type ConfirmDialogVariant = 'danger' | 'warning' | 'neutral';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  pendingLabel?: string;
  variant?: ConfirmDialogVariant;
}

export interface ConfirmDialogState {
  id: number;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  pendingLabel: string;
  variant: ConfirmDialogVariant;
  pending: boolean;
}

@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  private nextId = 1;
  private resolver: ((confirmed: boolean) => void) | null = null;

  readonly dialog = signal<ConfirmDialogState | null>(null);

  confirm(options: ConfirmDialogOptions): Promise<boolean> {
    this.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      this.dialog.set({
        id: this.nextId++,
        title: options.title,
        message: options.message,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel ?? 'Cancel',
        pendingLabel: options.pendingLabel ?? 'Working...',
        variant: options.variant ?? 'neutral',
        pending: false
      });
    });
  }

  cancel(): void {
    if (this.dialog()?.pending) {
      return;
    }
    this.resolve(false);
  }

  accept(): void {
    const dialog = this.dialog();
    if (!dialog || dialog.pending) {
      return;
    }
    this.dialog.set({ ...dialog, pending: true });
    queueMicrotask(() => this.resolve(true));
  }

  private resolve(confirmed: boolean): void {
    const resolver = this.resolver;
    this.resolver = null;
    this.dialog.set(null);
    resolver?.(confirmed);
  }
}
