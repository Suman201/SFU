import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ErrorCenter } from './error-center.service';
@Component({
  selector: 'sapiovian-error-center',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './error-center.html',
  styleUrl: './error-center.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ErrorCenterComponent {
  readonly errors = inject(ErrorCenter);
  readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('details');
  readonly copied = signal(false);
  readonly documentationFailed = signal(false);
  readonly diagnostic = computed(() =>
    this.errors.active() ? this.errors.diagnostic(this.errors.active()!) : '',
  );
  constructor() {
    effect(() => {
      if (!this.errors.active()) this.dialog()?.nativeElement.close();
    });
  }
  showDetails(): void {
    this.copied.set(false);
    this.documentationFailed.set(false);
    this.dialog()?.nativeElement.showModal();
  }
  closeDetails(): void {
    this.dialog()?.nativeElement.close();
  }
  dismiss(): void {
    this.closeDetails();
    this.errors.dismiss();
  }
  async openGuide(event: MouseEvent): Promise<void> {
    const item = this.errors.active();
    if (item)
      this.documentationFailed.set(
        !(await this.errors.openDocumentation(event, item.code)),
      );
  }
  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.diagnostic());
      this.copied.set(true);
    } catch {
      this.copied.set(false);
    } // Selectable diagnostics remain available if clipboard is blocked.
  }
}
