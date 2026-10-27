import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export type ClassroomWhiteboardSource = 'classroom' | 'device';

/** The same source picker is used by the website and installed classroom. */
@Component({
  selector: 'sfu-whiteboard-source', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="source-row">
      <label>Whiteboard source<select aria-label="Whiteboard source" [value]="source()" [disabled]="disabled() || busy()" (change)="sourceChange.emit($any($event.target).value)"><option value="classroom">Classroom whiteboard</option><option value="device">Share device whiteboard</option></select></label>
      @if (source() === 'device') {
        @if (sharing()) { <button type="button" [disabled]="busy()" (click)="stop.emit()">Stop device sharing</button> }
        @else if (student() && !canShare()) {
          <button type="button" [disabled]="disabled() || busy()" (click)="requestPending() ? cancelRequest.emit() : request.emit()">{{ requestPending() ? 'Cancel sharing request' : 'Request device sharing' }}</button>
        } @else { <button type="button" class="primary" [disabled]="disabled() || busy()" (click)="share.emit()">{{ busy() ? 'Starting share…' : 'Share device whiteboard' }}</button> }
      }
      @if (presenter()) { <span class="presenter" role="status">{{ presenter() }} · Device whiteboard · viewing only</span> }
    </div>
    @if (source() === 'device' && !sharing()) { <p class="hint">{{ student() && !canShare() ? (requestPending() ? 'Waiting for your teacher to allow sharing.' : 'Ask your teacher before presenting your device whiteboard.') : 'Open your device’s whiteboard software, then choose its window or screen. Everyone sees it as video; its drawing tools stay on your device.' }}</p> }
    @if (notice()) { <p class="hint" role="status">{{ notice() }}</p> }
  `,
  styles: [`:host{display:block;padding:10px 14px;border-bottom:1px solid var(--line-soft,#dce5df);background:var(--panel,#fff);color:var(--text,#15392c)}.source-row{display:flex;align-items:end;flex-wrap:wrap;gap:10px}label{font-size:11px;font-weight:650}select{display:block;margin-top:4px;max-width:100%;min-height:34px;border:1px solid var(--line,#cadbd1);border-radius:6px;padding:6px 28px 6px 9px;background:var(--control-bg,var(--panel,#fff));color:inherit;font:inherit;font-size:12px}button{min-height:34px;padding:6px 10px;border:1px solid var(--line,#cadbd1);border-radius:6px;background:var(--panel,#fff);color:inherit;font:inherit;font-size:12px;font-weight:600;cursor:pointer}.primary{background:#458b73;color:#fff;border-color:#458b73}button:disabled,select:disabled{opacity:.55;cursor:not-allowed}.hint{margin:7px 0 0;max-width:850px;color:var(--muted,#607469);font-size:11px;line-height:1.45}.presenter{align-self:center;font-size:11px;color:var(--muted,#607469)}button:focus-visible,select:focus-visible{outline:3px solid #458b73;outline-offset:2px}`]
})
export class WhiteboardSourceControl {
  readonly source = input<ClassroomWhiteboardSource>('classroom');
  readonly student = input(false);
  readonly disabled = input(false);
  readonly busy = input(false);
  readonly sharing = input(false);
  readonly canShare = input(true);
  readonly requestPending = input(false);
  readonly presenter = input('');
  readonly notice = input('');
  readonly sourceChange = output<ClassroomWhiteboardSource>();
  readonly share = output<void>();
  readonly stop = output<void>();
  readonly request = output<void>();
  readonly cancelRequest = output<void>();
}
