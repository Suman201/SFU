import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DesktopClass, DesktopService } from './desktop.service';

@Component({
  selector: 'sfu-desktop-upcoming', standalone: true, imports: [DatePipe, RouterLink], changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './desktop.scss', template: `
    <section aria-labelledby="upcoming-title">
      <div class="page-heading"><div><p class="eyebrow">YOUR CLASSROOM</p><h1 id="upcoming-title">Upcoming classes</h1><p class="muted">Times are shown in {{ timeZone }}.</p></div><div class="heading-actions"><a class="secondary" routerLink="/desktop/devices">Device setup</a><button class="secondary" (click)="load()" [disabled]="loading()">Refresh</button></div></div>
      @if (error()) { <div class="error" role="alert">{{ error() }} <button class="quiet" (click)="load()">Try again</button></div> }
      @if (loading() && !items().length) { <p class="empty" role="status">Loading your classes…</p> }
      @else if (!items().length && !error()) { <div class="empty"><h2>You're all caught up</h2><p>Your scheduled classes will appear here.</p><button class="secondary" (click)="desktop.website()">Open website</button></div> }
      <div class="class-list">
        @for (item of items(); track item.sessionId) {
          <article class="class-card" [class.live]="item.status === 'live'" [class.cancelled]="item.status === 'cancelled'">
            <div class="date-tile"><span>{{ item.scheduledAt | date:'MMM' }}</span><strong>{{ item.scheduledAt | date:'d' }}</strong><small>{{ item.scheduledAt | date:'EEE' }}</small></div>
            <div class="class-details"><div class="status-line"><span class="status" [class.live]="item.status === 'live'">{{ status(item) }}</span><span class="muted small">{{ item.role === 'teacher' ? 'Teaching' : 'Attending' }}</span></div><h2>{{ item.title }}</h2><p>{{ item.courseName || item.batchName }} · {{ item.teacherName }}</p><p class="muted small">{{ item.scheduledAt | date:'shortTime' }} · {{ item.durationMinutes }} minutes</p>@if (item.rescheduledAt && item.originalScheduledAt) { <p class="muted small">Previously {{ item.originalScheduledAt | date:'medium' }}</p> }</div>
            <div class="class-action">
              @if (item.status !== 'cancelled' && (item.role === 'teacher' || item.status === 'live')) { <a class="primary" [routerLink]="['/desktop/join']" [queryParams]="{sessionId:item.sessionId,batchId:item.batchId}">{{ item.role === 'teacher' ? (item.status === 'live' ? 'Enter class' : 'Prepare class') : 'Join class' }}</a> }
              @else if (item.status === 'cancelled') { <span class="muted">Cancelled</span> }
              @else { <span class="muted">Waiting for teacher</span> }
            </div>
          </article>
        }
      </div>
    </section>
  `
})
export class DesktopUpcoming {
  protected readonly desktop = inject(DesktopService);
  protected readonly items = this.desktop.classItems;
  protected readonly loading = this.desktop.classesLoading;
  protected readonly error = this.desktop.classesError;
  protected readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' ');
  protected load(): void { this.desktop.refreshClasses(); }
  protected status(item: DesktopClass): string {
    if (item.status === 'live') return 'Live now';
    if (item.status === 'cancelled') return 'Cancelled';
    if (item.rescheduledAt) return 'Rescheduled';
    const minutes = Math.ceil((Date.parse(item.scheduledAt) - Date.now()) / 60_000);
    return minutes > 0 && minutes <= 60 ? `Starts in ${minutes} min` : minutes <= 0 ? 'Waiting to start' : 'Scheduled';
  }
}
