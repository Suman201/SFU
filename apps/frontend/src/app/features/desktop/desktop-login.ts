import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthRole, AuthService } from '../../core/services/auth.service';
import { normalizeDesktopDestination } from '../../core/services/desktop-bridge';
import { BrandLogo } from '../../shared/brand-mark/brand-logo';
import { DesktopService } from './desktop.service';
import { SocialButtons } from '../auth/social/social-buttons';
import { SocialSignInService } from '../auth/social/social-sign-in.service';

@Component({
  selector: 'sfu-desktop-login', standalone: true, imports: [FormsModule, BrandLogo, SocialButtons], changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './desktop.scss',
  template: `
    <main class="login-page"><section class="login-card" aria-labelledby="login-title">
      <sfu-brand-logo class="login-brand" /><h1 id="login-title">Welcome back</h1>
      <p class="muted">Your next class and past lessons, in one place.</p>
      @if (socialAvailable()) {
        <label>Sign in as<select aria-label="Sign in as" name="role" [(ngModel)]="role" [disabled]="pending() || !!handoff()"><option value="student">Student</option><option value="teacher">Teacher</option></select></label>
        <sfu-social-buttons [role]="role" [disabled]="pending() || !!handoff()" [startSignIn]="startSocial" />
      }
      @if (waiting()) {
        <p class="notice" role="status">Complete sign-in in your browser, then return here.</p>
        <button class="quiet full" type="button" (click)="cancelSocial()">Cancel sign-in</button>
      }
      @if (handoff()) {
        @if (linking()) {
        <form (ngSubmit)="finishSocial()">
          <p class="muted small">Confirm your existing account to connect this sign-in method.</p>
          <label>Account email<input name="linkEmail" type="email" autocomplete="username" required maxlength="254" [(ngModel)]="linkEmail" [disabled]="pending()" /></label>
          <label>Account password<input name="linkPassword" type="password" autocomplete="current-password" required minlength="8" maxlength="128" [(ngModel)]="linkPassword" [disabled]="pending()" /></label>
          <button class="primary full" type="submit" [disabled]="pending() || !linkEmail.trim() || !linkPassword">{{ pending() ? 'Signing in…' : 'Link account and sign in' }}</button>
          <button class="quiet full" type="button" [disabled]="pending()" (click)="cancelSocial()">Cancel sign-in</button>
        </form>
        } @else {
          <p class="muted small">Your browser verified your identity. Continue to your {{ handoff()!.role }} account.</p>
          <button class="primary full" type="button" [disabled]="pending()" (click)="finishSocial()">{{ pending() ? 'Signing in…' : 'Finish signing in' }}</button>
          <button class="quiet full" type="button" [disabled]="pending()" (click)="linking.set(true)">Link an existing email/password account</button>
          <button class="quiet full" type="button" [disabled]="pending()" (click)="cancelSocial()">Cancel sign-in</button>
        }
      } @else {
      <form (ngSubmit)="login()">
        <label>Email<input name="email" type="email" autocomplete="username" required [(ngModel)]="email" [disabled]="pending()" /></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required [(ngModel)]="password" [disabled]="pending()" /></label>
        <label class="check-row"><input name="remember" type="checkbox" [(ngModel)]="remember" [disabled]="pending()" /> Keep me signed in on this computer</label>
        @if (auth.sessionNotice()) { <p class="notice" role="status">{{ auth.sessionNotice() }}</p> }
        <button class="primary full" type="submit" [disabled]="pending() || !email.trim() || !password">{{ pending() ? 'Signing in…' : 'Sign in' }}</button>
      </form>
      }
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      <button class="quiet" type="button" (click)="desktop.website('/forgot-password')">Forgot your password?</button>
      <p class="muted small">Use your existing teacher or student account.</p><button class="quiet" (click)="desktop.website()">Manage your account on the website</button>
    </section></main>
  `
})
export class DesktopLogin {
  protected readonly auth = inject(AuthService);
  protected readonly desktop = inject(DesktopService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  protected email = '';
  protected password = '';
  protected remember = true;
  protected role: AuthRole = 'student';
  protected linkEmail = '';
  protected linkPassword = '';
  protected readonly socialAvailable = signal(false);
  protected readonly waiting = signal(false);
  protected readonly linking = signal(false);
  protected readonly handoff = signal<{ ticket: string; verifier: string; role: AuthRole; remember: boolean } | null>(null);
  protected readonly pending = signal(false);
  protected readonly error = signal('');
  private generation = 0;
  constructor() {
    void this.desktop.initialize();
    if (this.desktop.bridge?.startSocialLogin) inject(SocialSignInService).providers().subscribe({ next: value => this.socialAvailable.set(value.google || value.apple), error: () => undefined });
    this.destroyRef.onDestroy(() => { this.generation++; this.handoff.set(null); this.linkPassword = ''; void this.desktop.bridge?.cancelSocialLogin().catch(() => undefined); });
  }
  protected readonly startSocial = async (provider: 'google' | 'apple'): Promise<void> => {
    if (this.pending() || this.handoff() || !this.desktop.bridge) return;
    const generation = ++this.generation, role = this.role, remember = this.remember;
    this.pending.set(true); this.waiting.set(true); this.linking.set(false); this.error.set(''); this.password = '';
    try {
      const result = await this.desktop.bridge.startSocialLogin(provider, role);
      if (generation !== this.generation) return;
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.ticket) || !/^[A-Za-z0-9_-]{43}$/.test(result.verifier)) throw new Error('The sign-in response could not be verified.');
      this.waiting.set(false);
      this.handoff.set({ ...result, role, remember });
    } catch (error) { if (generation === this.generation) this.error.set(this.auth.authErrorMessage(error)); }
    finally { if (generation === this.generation) { this.pending.set(false); this.waiting.set(false); } }
  };
  protected cancelSocial(): void {
    if (this.pending() && !this.waiting()) return;
    this.generation++; this.handoff.set(null); this.linking.set(false); this.linkPassword = ''; this.pending.set(false); this.waiting.set(false); this.error.set('');
    void this.desktop.bridge?.cancelSocialLogin().catch(() => undefined);
  }
  protected async finishSocial(): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    try { await this.exchangeSocial(this.linking(), this.generation); }
    finally { this.pending.set(false); }
  }
  private async exchangeSocial(link: boolean, generation: number): Promise<void> {
    const handoff = this.handoff();
    if (!handoff) return;
    this.error.set('');
    try {
      await firstValueFrom(this.auth.socialLogin(handoff.ticket, handoff.verifier, handoff.role, handoff.remember, link ? { email: this.linkEmail.trim(), password: this.linkPassword } : undefined).pipe(takeUntilDestroyed(this.destroyRef)));
      if (generation !== this.generation) return;
      this.handoff.set(null); this.linkPassword = '';
      await this.router.navigateByUrl(normalizeDesktopDestination(this.route.snapshot.queryParamMap.get('returnUrl')) ?? '/desktop/upcoming');
    } catch (error) {
      if (generation !== this.generation) return;
      this.linkPassword = '';
      const retryLink = error instanceof HttpErrorResponse && (error.status === 409 || (link && error.status === 401));
      if (retryLink) this.linking.set(true);
      if (!retryLink) this.handoff.set(null);
      this.error.set(this.auth.authErrorMessage(error));
    }
  }
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
