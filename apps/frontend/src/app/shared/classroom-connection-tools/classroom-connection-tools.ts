import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { WebRtcService } from '../../core/services/webrtc.service';

@Component({
  selector: 'sfu-classroom-connection-tools', standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" [attr.aria-pressed]="media.lowBandwidth()" [disabled]="busy()" (click)="toggle()">{{ media.lowBandwidth() ? 'Weak-connection mode on' : 'Weak-connection mode' }}</button>
    @if (media.lowBandwidth()) { <span role="status">Participant cameras are paused. Voice and lesson content stay available.</span> }
    @if (error()) { <span role="alert">{{ error() }}</span> }`,
  styles: [`:host{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}button{border:1px solid #458b73;border-radius:8px;background:transparent;color:inherit;padding:7px 10px;cursor:pointer}button[aria-pressed=true]{background:#458b73;color:#fff}button:focus-visible{outline:3px solid #ffd150;outline-offset:2px}span{max-width:320px}`]
})
export class ClassroomConnectionTools {
  protected readonly media = inject(WebRtcService);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected async toggle(): Promise<void> {
    this.busy.set(true); this.error.set('');
    try { await this.media.setLowBandwidth(!this.media.lowBandwidth()); }
    catch { this.error.set('Some streams could not be adjusted. Check your connection and try again.'); }
    finally { this.busy.set(false); }
  }
}
