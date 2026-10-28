import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { normalizeDesktopDestination } from '../../core/services/desktop-bridge';
import { BrandLogo } from '../../shared/brand-mark/brand-logo';
import { DesktopService } from './desktop.service';

@Component({
  selector: 'sfu-desktop-login', standalone: true, imports: [FormsModule, BrandLogo], changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './desktop.scss',
  template: `
    <main class="login-page"><section class="login-card" aria-labelledby="login-title">
      <sfu-brand-logo class="login-brand" /><h1 id="login-title">Welcome back</h1>
      <p class="muted">Your next class and past lessons, in one place.</p>
      <form (ngSubmit)="login()">
        <label>Email<input name="email" type="email" autocomplete="username" required [(ngModel)]="email" /></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required [(ngModel)]="password" /></label>
        <label class="check-row"><input name="remember" type="checkbox" [(ngModel)]="remember" /> Keep me signed in on this computer</label>
        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
        @if (auth.sessionNotice()) { <p class="notice" role="status">{{ auth.sessionNotice() }}</p> }
        <button class="primary full" type="submit" [disabled]="pending() || !email.trim() || !password">{{ pending() ? 'Signing in…' : 'Sign in' }}</button>
      </form>
      <p class="muted small">Use your existing teacher or student account.</p><button class="quiet" (click)="desktop.website()">Manage your account on the website</button>
    </section></main>
  `
})
export class DesktopLogin {
  protected readonly auth = inject(AuthService);
  protected readonly desktop = inject(DesktopService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected email = '';
  protected password = '';
  protected remember = true;
  protected readonly pending = signal(false);
  protected readonly error = signal('');
  constructor() { void this.desktop.initialize(); }
  protected login(): void {
    if (this.pending()) return;
    this.pending.set(true); this.error.set('');
    this.auth.login(this.email.trim(), this.password, undefined, this.remember).subscribe({
      next: () => {
        this.password = ''; this.pending.set(false);
        const destination = normalizeDesktopDestination(this.route.snapshot.queryParamMap.get('returnUrl')) ?? '/desktop/upcoming';
        void this.router.navigateByUrl(destination);
      },
      error: (error) => { this.pending.set(false); this.error.set(this.auth.authErrorMessage(error)); }
    });
  }
}
