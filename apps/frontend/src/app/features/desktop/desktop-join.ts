import { ChangeDetectionStrategy, Component, OnDestroy, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { DesktopService } from './desktop.service';
import { ClassSessionService } from '../class-session/class-session.service';

@Component({ selector: 'sfu-desktop-join', standalone: true, imports: [RouterLink], changeDetection: ChangeDetectionStrategy.OnPush, styleUrl: './desktop.scss', template: `
  <section class="empty" aria-live="polite"><h1>{{ error() ? 'Unable to open this class' : 'Opening your classroom…' }}</h1>
  @if (error()) { <p class="error" role="alert">{{ error() }}</p><button class="primary" (click)="open()">Try again</button> }
  <a class="secondary" routerLink="/desktop/upcoming">Back to classes</a></section>` })
export class DesktopJoin implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sessions = inject(ClassSessionService);
  private readonly desktop = inject(DesktopService);
  protected readonly error = signal('');
  private request?: Subscription;
  private readonly routeSubscription = this.route.queryParamMap.subscribe(() => this.open());
  protected open(): void {
    const id = this.route.snapshot.queryParamMap.get('sessionId');
    if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) { this.error.set('The class invitation is incomplete. Choose a class from your upcoming list.'); return; }
    this.error.set(''); this.request?.unsubscribe();
    this.request = this.desktop.classroom(id).subscribe({
      next: (session) => {
        if (session.status === 'completed') { this.error.set('This class has ended. Published recordings are available in Recordings.'); return; }
        if (session.status === 'cancelled') { this.error.set('This class has been cancelled.'); return; }
        if (session.role === 'student' && (!session.canJoin || session.status !== 'live')) { this.error.set('The teacher has not started this class yet. Please try again shortly.'); return; }
        void this.router.navigate(['/class-session', session.role === 'student' ? 'student' : 'teacher'], { queryParams: { sessionId: session.sessionId, batchId: session.batchId, desktop: '1' }, replaceUrl: true });
      }, error: (error) => this.error.set(this.sessions.errorMessage(error))
    });
  }
  ngOnDestroy(): void { this.request?.unsubscribe(); this.routeSubscription.unsubscribe(); }
}
