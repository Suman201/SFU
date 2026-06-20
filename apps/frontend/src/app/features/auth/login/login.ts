import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { email, FormField, FormRoot, form as signalForm, minLength, required } from '@angular/forms/signals';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthRole, AuthService } from '../../../core/services/auth.service';
import { AuthLayout } from '../auth-layout/auth-layout';

interface LoginFormModel {
  email: string;
  password: string;
}

@Component({
  selector: 'sfu-login',
  standalone: true,
  imports: [AuthLayout, FormField, FormRoot, RouterLink],
  templateUrl: './login.html',
  styleUrl: './login.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class Login {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly expectedRole = (this.route.snapshot.data['role'] as AuthRole | undefined) ?? 'student';
  protected readonly alternateRole: AuthRole = this.expectedRole === 'teacher' ? 'student' : 'teacher';
  protected readonly title = `${this.roleLabel(this.expectedRole)} login`;
  protected readonly subtitle =
    this.expectedRole === 'teacher'
      ? 'Sign in to manage batches, students, schedules, and live class controls.'
      : 'Sign in to discover teachers, track enrolled batches, and join live classes.';
  protected readonly alternateLoginPath = `/${this.alternateRole}/login`;
  protected readonly formModel = signal<LoginFormModel>({
    email: 'host@example.com',
    password: 'Password@12345'
  });
  protected readonly form = signalForm(this.formModel, (path) => {
    required(path.email);
    email(path.email);
    required(path.password);
    minLength(path.password, 10);
  });

  protected submit(event?: Event): void {
    event?.preventDefault();
    this.form().markAsTouched();

    if (this.form().invalid()) {
      return;
    }

    this.busy.set(true);
    this.error.set('');
    const value = this.formModel();
    this.auth.login(value.email, value.password, this.expectedRole).subscribe({
      next: ({ user }) => {
        const returnUrl = this.safeReturnUrl(user.role);
        void this.router.navigateByUrl(returnUrl ?? this.auth.redirectPathFor(user.role));
      },
      error: (error: unknown) => {
        this.error.set(this.auth.authErrorMessage(error));
        this.busy.set(false);
      },
      complete: () => this.busy.set(false)
    });
  }

  private safeReturnUrl(role: AuthRole): string | null {
    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
    if (!returnUrl?.startsWith('/')) {
      return null;
    }
    if (role === 'teacher' && returnUrl.startsWith('/teacher/')) {
      return returnUrl;
    }
    if (role === 'student' && returnUrl.startsWith('/student/')) {
      return returnUrl;
    }
    return null;
  }

  private roleLabel(role: AuthRole): string {
    return role.charAt(0).toUpperCase() + role.slice(1);
  }
}
