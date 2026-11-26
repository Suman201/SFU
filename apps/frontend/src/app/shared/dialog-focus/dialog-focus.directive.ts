import { Directive, DestroyRef, ElementRef, HostListener, afterNextRender, inject, output } from '@angular/core';

/** Focus stays inside a custom modal; nested native dialogs retain browser handling. */
@Directive({ selector: '[sfuDialogFocus]', standalone: true })
export class DialogFocusDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly previous = this.host.ownerDocument.activeElement as HTMLElement | null;
  readonly dialogEscape = output<void>();
  constructor() {
    afterNextRender(() => {
      const first = this.focusable()[0];
      if (first) first.focus(); else { this.host.tabIndex = -1; this.host.focus(); }
    });
    inject(DestroyRef).onDestroy(() => {
      const active = this.host.ownerDocument.activeElement;
      if (this.previous?.isConnected && (this.host.contains(active) || active === this.host.ownerDocument.body)) this.previous.focus();
    });
  }
  @HostListener('keydown', ['$event'])
  protected keydown(event: KeyboardEvent): void {
    if ((event.target as Element | null)?.closest('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.dialogEscape.emit(); return; }
    if (event.key !== 'Tab') return;
    const elements = this.focusable();
    const active = this.host.ownerDocument.activeElement;
    if (!elements.length) { event.preventDefault(); this.host.focus(); return; }
    const first = elements[0]!, last = elements.at(-1)!;
    if (event.shiftKey && (active === first || active === this.host)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || active === this.host)) { event.preventDefault(); first.focus(); }
  }
  private focusable(): HTMLElement[] {
    return Array.from(this.host.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex]'))
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert],[hidden]') && element.getClientRects().length > 0);
  }
}
