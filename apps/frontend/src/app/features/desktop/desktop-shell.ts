import { ClassNotices } from '../../shared/class-notices';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { BrandLogo } from '../../shared/brand-mark/brand-logo';
import { DesktopService } from './desktop.service';

@Component({
  selector: 'sfu-desktop-shell', standalone: true, imports: [RouterLink, RouterLinkActive, RouterOutlet, BrandLogo, ClassNotices],
  changeDetection: ChangeDetectionStrategy.OnPush, styleUrl: './desktop.scss',
  template: `
    <div class="desktop-shell">
      <header class="desktop-header">
        <a class="brand" routerLink="/desktop/upcoming"><sfu-brand-logo [tagline]="false" /></a>
        <nav aria-label="Main navigation">
          <a routerLink="/desktop/upcoming" routerLinkActive="active">Upcoming classes</a>
          @if(auth.role()==='student'){<a routerLink="/desktop/batches" routerLinkActive="active">Explore batches</a>}
          <a routerLink="/desktop/calendar" routerLinkActive="active">Calendar</a>
          <a routerLink="/desktop/recordings" routerLinkActive="active">Recordings</a>
        </nav>
        <div class="account"><sfu-class-notices /><span>{{ auth.user()?.name }}</span><a class="settings-link" routerLink="/desktop/settings" routerLinkActive="active" aria-label="Settings" title="Settings"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" d="m9 3-.6 2.2-1.7 1L4.5 6l-2 3.5L4 11v2l-1.5 1.5L4.5 18l2.2-.2 1.7 1L9 21h6l.6-2.2 1.7-1 2.2.2 2-3.5L20 13v-2l1.5-1.5-2-3.5-2.2.2-1.7-1L15 3Z"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/></svg><span>Settings</span></a><button class="quiet" (click)="desktop.logout()">Sign out</button></div>
      </header>
      @if (desktop.notice()) { <div class="notice" role="status">{{ desktop.notice() }} <button class="quiet" (click)="desktop.notice.set('')" aria-label="Dismiss notice">Dismiss</button></div> }
      @if (desktop.lessonRecording.pending()) { <div class="notice" role="status"><span>{{ desktop.lessonRecording.notice() || 'A saved lesson recording is waiting to upload.' }}</span><a routerLink="/desktop/settings">View status</a></div> }
      <main class="desktop-main" id="main-content"><router-outlet /></main>
      <footer class="desktop-footer"><span>{{ desktop.version() }}</span><button class="quiet" (click)="desktop.website()">Open website</button></footer>
    </div>
  `
})
export class DesktopShell {
  protected readonly auth = inject(AuthService);
  protected readonly desktop = inject(DesktopService);
  constructor() { void this.desktop.initialize(); }
}
