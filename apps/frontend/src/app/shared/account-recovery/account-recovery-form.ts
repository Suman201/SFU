import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, Input, OnDestroy, OnInit, inject, output, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Meta } from '@angular/platform-browser';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EXPECTED_ERROR_STATUSES } from '@sapiovian/error-ui';

/** Shared web/admin recovery UI. It never stores reset tokens or signs a user in. */
@Component({
  selector: 'sfu-account-recovery-form', standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './account-recovery-form.html', styleUrl: './account-recovery-form.scss',
})
export class AccountRecoveryForm implements OnInit, OnDestroy {
  @Input({ required: true }) apiBaseUrl!: string;
  @Input() mode: 'request' | 'reset' = 'request';
  @Input() loginPath = '/student/login';
  @Input() requestPath = '/forgot-password';
  @Input() role = 'student';
  readonly completed = output<void>();
  private readonly http = inject(HttpClient);
  private readonly meta = inject(Meta);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly forms = inject(FormBuilder);
  private token = '';
  private generation = 0;
  private capturedRole: 'student' | 'teacher' | null = null;
  private readonly hashChanged = () => { if (location.hash) this.captureLink(); };
  private previousReferrer: string | null = null;
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly requested = signal(false);
  protected readonly done = signal(false);
  protected readonly validLink = signal(false);
  protected readonly showPasswords = signal(false);
  protected readonly requestForm = this.forms.nonNullable.group({ email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]] });
  protected readonly resetForm = this.forms.nonNullable.group({
    password: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(72)]],
    confirm: ['', [Validators.required]],
  }, { validators: (control: AbstractControl) => control.get('password')?.value === control.get('confirm')?.value ? null : { passwordMismatch: true } });

  ngOnInit(): void {
    if (this.mode !== 'reset') return;
    this.previousReferrer = this.meta.getTag('name="referrer"')?.content ?? null;
    this.meta.updateTag({ name: 'referrer', content: 'no-referrer' });
    this.captureLink();
    window.addEventListener('hashchange', this.hashChanged);
    this.router.events.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (event instanceof NavigationEnd && location.hash) this.captureLink();
    });
  }
  private captureLink(): void {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const token = fragment.get('token');
    const role = fragment.get('role');
    this.capturedRole = this.loginPath !== '/login' && (role === 'student' || role === 'teacher') ? role : null;
    this.generation++; this.token = ''; this.validLink.set(false); this.done.set(false); this.error.set(''); this.busy.set(false); this.resetForm.reset();
    history.replaceState(history.state, '', location.pathname);
    // Keep Angular's navigation state aligned; otherwise it can restore an old fragment after a same-document navigation.
    if (this.router.navigated) void this.router.navigateByUrl(location.pathname, { replaceUrl: true });
    if (token && /^[a-f0-9]{64}$/.test(token)) { this.token = token; this.validLink.set(true); }
    else this.error.set('This reset link is incomplete or invalid. Request a new link.');
  }
  protected loginDestination(): string { return this.capturedRole ? '/' + this.capturedRole + '/login' : this.loginPath; }
  protected requestRole(): string { return this.capturedRole ?? this.role; }
  ngOnDestroy(): void {
    this.generation++; this.token = '';
    window.removeEventListener('hashchange', this.hashChanged);
    if (this.mode === 'reset') {
      if (this.previousReferrer === null) this.meta.removeTag('name="referrer"');
      else this.meta.updateTag({ name: 'referrer', content: this.previousReferrer });
    }
  }
  protected request(): void {
    this.requestForm.markAllAsTouched();
    if (this.requestForm.invalid || this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.http.post<void>(`${this.apiBaseUrl}/auth/forgot-password`, this.requestForm.getRawValue(), this.options()).subscribe({
      next: () => { this.busy.set(false); this.requested.set(true); },
      error: error => this.fail(error),
    });
  }
  protected reset(): void {
    this.resetForm.markAllAsTouched();
    if (this.resetForm.invalid || !this.validLink() || this.busy()) return;
    this.busy.set(true); this.error.set('');
    const generation = this.generation;
    this.http.post<void>(`${this.apiBaseUrl}/auth/reset-password`, { token: this.token, password: this.resetForm.getRawValue().password }, this.options()).subscribe({
      next: () => {
        if (generation !== this.generation) return;
        this.token = ''; this.resetForm.reset(); this.busy.set(false); this.done.set(true); this.completed.emit();
      },
      error: error => {
        if (generation !== this.generation) return;
        this.resetForm.reset();
        if (error instanceof HttpErrorResponse && error.status === 400 && typeof error.error?.message === 'string' && /link/i.test(error.error.message)) this.validLink.set(false);
        this.fail(error);
      },
    });
  }
  private options() { return { context: new HttpContext().set(EXPECTED_ERROR_STATUSES, [400, 401, 429]) }; }
  private fail(error: unknown): void {
    this.busy.set(false);
    if (error instanceof HttpErrorResponse && error.status === 429) this.error.set('Too many requests. Wait a minute and try again.');
    else if (error instanceof HttpErrorResponse && error.status === 400 && typeof error.error?.message === 'string') this.error.set(error.error.message);
    else this.error.set('Account recovery is temporarily unavailable. Please try again.');
  }
}
