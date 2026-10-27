import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, ViewChild, input, output, signal } from '@angular/core';
import { DeviceSetupComponent } from './device-setup';

/** Native modal traps focus and handles Escape without leaving the classroom. */
@Component({
  selector: 'sfu-device-setup-dialog', standalone: true, imports: [DeviceSetupComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button #trigger class="device-trigger" type="button" aria-label="Device setup" title="Device setup" aria-haspopup="dialog" (click)="open()">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 3-.6 2-2 .9-1.9-.5-2.5 4.2L4 11v2l-1.5 1.4L5 18.6l1.9-.5 2 .9.6 2h5l.6-2 2-.9 1.9.5 2.5-4.2L20 13v-2l1.5-1.4L19 5.4l-1.9.5-2-.9-.6-2Z"/><circle cx="12" cy="12" r="3"/></svg><span>Device setup</span>
    </button>
    <dialog #dialog aria-label="Device setup" (close)="closed()" (cancel)="close()">
      <header><div><p>Classroom settings</p><h1>Device setup</h1></div><button type="button" class="close" aria-label="Close device setup" (click)="close()">✕</button></header>
      @if (opened()) {
        <sfu-device-setup [live]="true" [previewStream]="previewStream()" (microphoneSelected)="microphoneSelected.emit($event)" (cameraSelected)="cameraSelected.emit($event)" />
        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      }
    </dialog>`,
  styles: [`:host{display:inline-flex}.device-trigger{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line,#d9e1df);border-radius:8px;padding:8px 10px;background:var(--panel,#fff);color:var(--text,#172a25);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}.device-trigger svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6}.device-trigger:focus-visible,.close:focus-visible{outline:3px solid #458b73;outline-offset:3px}dialog{width:min(820px,calc(100vw - 40px));max-height:calc(100dvh - 50px);padding:26px;border:1px solid var(--line,#d9e1df);border-radius:16px;background:var(--bg,#f7faf8);color:var(--text,#172a25);box-shadow:0 24px 80px #0004}dialog::backdrop{background:#14231e99}header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:20px}header p{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted,#65736e);margin:0 0 7px}h1{font-size:24px;margin:0}.close{width:36px;height:36px;border:1px solid var(--line,#d9e1df);border-radius:8px;background:var(--panel,#fff);color:inherit;cursor:pointer}.error{padding:12px;background:var(--danger-soft,#fff1f3);color:var(--danger,#a82d40);border-radius:8px;font-size:13px}@media(max-width:600px){dialog{padding:18px}.device-trigger span{display:none}}`]
})
export class DeviceSetupDialogComponent implements OnDestroy {
  @ViewChild('dialog', { static: true }) private dialog!: ElementRef<HTMLDialogElement>;
  @ViewChild('trigger', { static: true }) private trigger!: ElementRef<HTMLButtonElement>;
  readonly previewStream = input<MediaStream | null>(null);
  readonly error = input('');
  readonly microphoneSelected = output<string>();
  readonly cameraSelected = output<string>();
  protected readonly opened = signal(false);
  protected open(): void { this.opened.set(true); this.dialog.nativeElement.showModal(); }
  protected close(): void { this.dialog.nativeElement.close(); this.closed(); }
  protected closed(): void { this.opened.set(false); this.trigger.nativeElement.focus(); }
  ngOnDestroy(): void { this.dialog.nativeElement.close(); }
}
