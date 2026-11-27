import { Component, Input, inject, signal } from '@angular/core';
import { AuthRole, AuthService } from '../../../core/services/auth.service';
import { SocialSignInService } from './social-sign-in.service';

@Component({
  selector: 'sfu-social-buttons', standalone: true,
  host: { '[class.available]': 'providers().google || providers().apple' },
  template: `@if (providers().google || providers().apple) {
    <div class="social-options" aria-label="Other ways to sign in">
      @if (providers().google) { <button type="button" [disabled]="busy() || disabled" (click)="start('google')"><svg aria-hidden="true" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.4 38.02 46.98 31.87 46.98 24.55Z"/><path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.8 23.8 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>Continue with Google</button> }
      @if (providers().apple) { <button type="button" [disabled]="busy() || disabled" (click)="start('apple')"><svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M17.1 12.6c0-2.1 1.7-3.2 1.8-3.3-1-1.5-2.6-1.7-3.1-1.7-1.3-.2-2.6.8-3.3.8-.7 0-1.8-.8-2.9-.8-1.5 0-2.9.9-3.7 2.2-1.6 2.7-.4 6.8 1.1 9 .7 1 1.5 2.1 2.6 2 1.1 0 1.5-.7 2.8-.7s1.7.7 2.9.7 1.9-1 2.6-2c.8-1.2 1.2-2.4 1.2-2.5-.1 0-2-.8-2-3.7zM14.9 6.2c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.8 1.4-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.5 2.8-1.3z"/></svg>Continue with Apple</button> }
      @if (error()) { <p role="alert">{{ error() }}</p> }
      <div class="divider"><span>or use email</span></div>
    </div>
  }`,
  styles: `:host{display:none;min-width:0}:host(.available){display:block}.social-options{display:grid;gap:10px}button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:44px;border:1px solid var(--line);border-radius:var(--radius);background:var(--control-bg);color:var(--text);font:inherit;font-size:14px;font-weight:600;cursor:pointer}button:hover{border-color:var(--accent-strong)}button:focus-visible{outline:2px solid var(--accent-strong);outline-offset:3px}button:disabled{opacity:.6;cursor:wait}svg{height:22px;width:22px}.divider{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:12px;margin-top:6px}.divider:before,.divider:after{content:'';height:1px;flex:1;background:var(--line)}p{margin:0;color:var(--danger);font-size:13px}`,
})
export class SocialButtons {
  @Input() role: AuthRole = 'student';
  @Input() disabled = false;
  @Input() startSignIn?: (provider: 'google' | 'apple') => Promise<void>;
  @Input() rememberMe = false;
  @Input() returnUrl: string | null = null;
  private readonly social = inject(SocialSignInService);
  private readonly auth = inject(AuthService);
  protected readonly providers = signal({ google: false, apple: false });
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  constructor() { this.social.providers().subscribe({ next: value => this.providers.set(value), error: () => undefined }); }
  protected async start(provider: 'google' | 'apple'): Promise<void> {
    if (this.busy() || this.disabled) return;
    this.busy.set(true); this.error.set('');
    try {
      if (this.startSignIn) { await this.startSignIn(provider); this.busy.set(false); }
      else await this.social.start(provider, this.role, this.rememberMe, this.returnUrl);
    }
    catch (error) { this.error.set(this.auth.authErrorMessage(error)); this.busy.set(false); }
  }
}
