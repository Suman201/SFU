import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { AuthLayout } from '../auth-layout/auth-layout';
import { SocialSignInService } from './social-sign-in.service';

@Component({
  standalone: true, imports: [AuthLayout, RouterLink],
  template: `<sfu-auth-layout [role]="pending?.role ?? 'student'" title="Complete sign-in">
    <div class="callback-panel">
      <h1>Complete sign-in</h1>
      @if (ticket && pending) {
        <p>Continue with {{ pending.provider === 'google' ? 'Google' : 'Apple' }} to your {{ pending.role }} account.</p>
        @if (linking()) {
          <form (submit)="finish($event)">
            <p>Confirm your existing account to connect this sign-in method.</p>
            <label>Email<input type="email" autocomplete="username" required maxlength="254" [value]="email()" (input)="email.set($any($event.target).value)"></label>
            <label>Password<input type="password" autocomplete="current-password" required minlength="8" maxlength="128" [value]="password()" (input)="password.set($any($event.target).value)"></label>
            <button class="primary" type="submit" [disabled]="busy()">{{ busy() ? 'Signing in…' : 'Link account and sign in' }}</button>
          </form>
        } @else {
          <button class="primary" type="button" [disabled]="busy()" (click)="finish()">{{ busy() ? 'Signing in…' : 'Finish signing in' }}</button>
          <button class="link-button" type="button" [disabled]="busy()" (click)="linking.set(true)">Link an existing email/password account</button>
        }
      }
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      <a [routerLink]="'/' + (pending?.role ?? 'student') + '/login'" (click)="social.clear()">Back to login</a>
    </div>
  </sfu-auth-layout>`,
  styles: `.callback-panel,form{display:grid;gap:16px;min-width:0}h1{margin:0;font-size:26px;color:var(--text)}p{margin:0;color:var(--muted);line-height:1.6}label{display:grid;gap:8px;color:var(--muted);font-size:13px}input{min-width:0;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:var(--radius);background:var(--control-bg);color:var(--text);font:inherit}button{min-height:44px}a,.link-button{color:var(--accent-strong);font-size:13px}.link-button{background:none;border:0;cursor:pointer;text-decoration:underline}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--accent-strong);outline-offset:3px}.error{color:var(--danger)}`,
})
export class SocialCallback {
  protected readonly social = inject(SocialSignInService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly pending = this.social.pending();
  protected readonly ticket: string | null;
  protected readonly busy = signal(false);
  protected readonly linking = signal(false);
  protected readonly error = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  constructor() {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const ticket = fragment.get('ticket');
    this.ticket = ticket && /^[A-Za-z0-9_-]{43}$/.test(ticket) ? ticket : null;
    // Remove the one-time handoff immediately; it must not enter referrers or navigation history.
    history.replaceState(history.state, '', window.location.pathname + window.location.search);
    if (!this.ticket || !this.pending) {
      this.error.set(fragment.get('error') === 'cancelled' ? 'Sign-in was cancelled. You can try again.' : 'This sign-in attempt expired or could not be verified. Please start again.');
      this.social.clear();
    }
  }
  protected finish(event?: Event): void {
    event?.preventDefault();
    if (!this.pending || !this.ticket || this.busy()) return;
    this.busy.set(true); this.error.set('');
    const credentials = this.linking() ? { email: this.email(), password: this.password() } : undefined;
    this.auth.socialLogin(this.ticket, this.pending.verifier, this.pending.role, this.pending.rememberMe, credentials).subscribe({
      next: ({ user }) => {
        this.password.set(''); this.social.clear();
        void this.router.navigateByUrl(this.pending!.returnUrl ?? this.auth.redirectPathFor(user.role), { replaceUrl: true });
      },
      error: error => {
        this.busy.set(false); this.password.set('');
        if (error instanceof HttpErrorResponse && error.status === 409) this.linking.set(true);
        this.error.set(this.auth.authErrorMessage(error));
      },
    });
  }
}
