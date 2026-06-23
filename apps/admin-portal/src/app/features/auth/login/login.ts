import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'sfu-admin-login',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class AdminLogin {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly showPassword = signal(false);
  protected readonly sessionNotice = this.auth.sessionNotice;
  protected readonly form = this.formBuilder.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(8)]],
    rememberMe: [false]
  });

  protected submit(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.busy()) {
      return;
    }
    const value = this.form.getRawValue();
    this.busy.set(true);
    this.error.set('');
    this.auth.login(value.email, value.password, value.rememberMe).subscribe({
      next: () => void this.router.navigateByUrl(this.safeReturnUrl() ?? this.auth.redirectPath()),
      error: (error: unknown) => {
        this.error.set(this.auth.authErrorMessage(error));
        this.busy.set(false);
      },
      complete: () => this.busy.set(false)
    });
  }

  protected togglePassword(): void {
    this.showPassword.update((value) => !value);
  }

  private safeReturnUrl(): string | null {
    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
    if (!returnUrl?.startsWith('/') || returnUrl.startsWith('//') || returnUrl.startsWith('/login')) {
      return null;
    }
    return returnUrl;
  }
}
