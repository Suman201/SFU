import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LessonRecordingService } from '../../core/services/lesson-recording.service';
import { ThemeService, ThemePreference } from '../../core/services/theme.service';
import { DesktopService } from './desktop.service';

@Component({ selector: 'sfu-desktop-settings', standalone: true, imports: [FormsModule, RouterLink], changeDetection: ChangeDetectionStrategy.OnPush, styleUrl: './desktop.scss', template: `
  <section aria-labelledby="settings-title"><div class="page-heading"><div><p class="eyebrow">MAKE YOURSELF COMFORTABLE</p><h1 id="settings-title">Settings</h1><p class="muted">Check your devices before your next class.</p></div></div>
  <div class="settings-grid">
    <section class="settings-card"><h2>Device setup</h2><p class="muted">Choose and test your microphone, speakers, and webcam. Your choices are remembered for your next class.</p><a class="primary" routerLink="/desktop/devices">Open device setup</a></section>
    <div class="settings-stack">
      <section class="settings-card"><h2>Preferences</h2><label class="check-row"><input type="checkbox" [disabled]="!desktop.bridge" [ngModel]="desktop.reminderEnabled()" (ngModelChange)="desktop.setReminders($event)" /> Remind me before class</label><p class="muted small">{{ desktop.bridge ? 'Get a notification shortly before your scheduled class. Keep the app running for reminders.' : 'Class reminders are available in the installed app.' }}</p>
        <label>Appearance<select aria-label="Appearance" [ngModel]="theme.theme()" (ngModelChange)="setTheme($event)"><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      </section>
      <section class="settings-card"><h2>App updates</h2><p class="muted small">{{ desktop.version() }}</p><p role="status">{{ desktop.updateState().message }}</p>
        @if (desktop.bridge) { <button class="secondary" [disabled]="updateBusy() || desktop.updateState().status === 'checking' || desktop.updateState().status === 'downloading'" (click)="checkUpdates()">Check for updates</button>@if (desktop.updateState().status === 'ready' || desktop.updateState().status === 'available') { <button class="primary" [disabled]="updateBusy()" (click)="installUpdate()">{{ desktop.updateState().status === 'available' ? 'Download update' : 'Restart and update' }}</button> } }
        <p class="muted small">Updates will not restart the app during an active class.</p>
      </section>
      @if (recording.pending()) { <section class="settings-card"><h2>Saved recording</h2><p role="status">{{ recording.notice() || 'A lesson recording is waiting to upload.' }}</p><button class="secondary" (click)="recoverRecording()">Retry upload</button></section> }
    </div>
    <section class="settings-card report-card"><h2>Report a problem</h2><p class="muted">Save a report to share with your support team.</p><label>What happened?<textarea rows="3" maxlength="2000" [(ngModel)]="description" placeholder="Describe the problem and what you were trying to do."></textarea></label><label class="check-row"><input type="checkbox" [(ngModel)]="includeDiagnostics" /> Include app version, operating system, and connection diagnostics</label><p class="muted small">Your password, authentication tokens, camera, microphone, and lesson content are not included.</p><button class="secondary" [disabled]="reportBusy() || !description.trim()" (click)="saveReport()">{{ reportBusy() ? 'Saving…' : 'Save problem report' }}</button>@if (reportNotice()) { <p role="status">{{ reportNotice() }}</p> }</section>
  </div></section>` })
export class DesktopSettings {
  protected readonly desktop = inject(DesktopService);
  protected readonly recording = inject(LessonRecordingService);
  protected readonly theme = inject(ThemeService);
  protected readonly updateBusy = signal(false);
  protected readonly reportBusy = signal(false);
  protected readonly reportNotice = signal('');
  protected description = '';
  protected includeDiagnostics = false;
  protected setTheme(value: ThemePreference): void { this.theme.setPreference(value); }
  protected async checkUpdates(): Promise<void> { this.updateBusy.set(true); try { const state = await this.desktop.bridge?.checkForUpdates(); if (state) this.desktop.updateState.set(state); } catch { this.desktop.updateState.set({ status: 'error', message: 'Could not check for updates. Please try again.' }); } finally { this.updateBusy.set(false); } }
  protected async installUpdate(): Promise<void> { this.updateBusy.set(true); try { const state = await this.desktop.bridge?.installUpdate(); if (state) this.desktop.updateState.set(state); } catch { this.desktop.updateState.set({ status: 'error', message: 'Could not install the update. Please try again.' }); } finally { this.updateBusy.set(false); } }
  protected async recoverRecording(): Promise<void> { try { await this.recording.recover(); } catch { this.reportNotice.set('The recording upload could not complete. Your saved media is still on this computer.'); } }
  protected async saveReport(): Promise<void> {
    if (!this.description.trim() || this.reportBusy()) return;
    this.reportBusy.set(true); this.reportNotice.set('');
    try {
      if (this.desktop.bridge) {
        const result = await this.desktop.bridge.saveDiagnostics({ description: this.description.trim(), includeDiagnostics: this.includeDiagnostics });
        this.reportNotice.set(result.saved ? 'Report saved. You can attach it when contacting support.' : 'Saving was cancelled.');
      } else {
        const report = { description: this.description.trim(), ...(this.includeDiagnostics ? { appVersion: this.desktop.version(), userAgent: navigator.userAgent, online: navigator.onLine, timestamp: new Date().toISOString() } : {}) };
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = 'classroom-problem-report.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
        this.reportNotice.set('Report saved. You can attach it when contacting support.');
      }
    } catch { this.reportNotice.set('The report could not be saved. Please try again.'); }
    finally { this.reportBusy.set(false); }
  }
}
