import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ErrorCenter, ErrorCenterComponent } from '@sapiovian/error-ui';
import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  NavigationError,
  NavigationStart,
  Router,
  RouterOutlet,
} from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { ThemeService } from './core/services/theme.service';
import { ConfirmDialogComponent } from './shared/confirm-dialog/confirm-dialog.component';

@Component({
  selector: 'sfu-admin-root',
  standalone: true,
  imports: [ConfirmDialogComponent, RouterOutlet, ErrorCenterComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (auth.checking() && !publicReference()) {
      <main class="auth-loading" aria-live="polite">
        <div>
          <span class="loader" aria-hidden="true"></span>
          <strong>Checking admin session</strong>
          <p>Restoring secure access.</p>
        </div>
      </main>
    }
    <router-outlet />
    <sapiovian-error-center />
    <sfu-admin-confirm-dialog />
  `,
})
export class AppComponent {
  protected readonly auth = inject(AuthService);
  protected readonly publicReference = signal(
    /^\/error-encyclopedia(?:\/|$)/.test(globalThis.location?.pathname ?? ''),
  );

  constructor() {
    const errors = inject(ErrorCenter);
    let previousAccount = this.auth.user()?.id ?? null;
    effect(() => {
      const account = this.auth.user()?.id ?? null;
      if (account !== previousAccount) {
        previousAccount = account;
        errors.clear();
      }
    });
    inject(Router)
      .events.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (event instanceof NavigationStart)
          this.publicReference.set(
            /^\/error-encyclopedia(?:[/?#]|$)/.test(event.url),
          );
        if (event instanceof NavigationError)
          errors.capture(event.error, { path: event.url });
      });
    inject(ThemeService);
    if (!this.publicReference()) this.auth.checkSession().subscribe();
  }
}
