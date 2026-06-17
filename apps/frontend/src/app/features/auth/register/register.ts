import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { email, FormField, FormRoot, form as signalForm, maxLength, minLength, required } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

interface RegisterFormModel {
  displayName: string;
  email: string;
  password: string;
}

@Component({
  selector: 'sfu-register',
  standalone: true,
  imports: [Footer, FormField, FormRoot, Header, RouterLink],
  templateUrl: './register.html',
  styleUrl: './register.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class Register {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly formModel = signal<RegisterFormModel>({
    displayName: 'Host',
    email: 'host@example.com',
    password: 'Password@12345'
  });
  protected readonly form = signalForm(this.formModel, (path) => {
    required(path.displayName);
    maxLength(path.displayName, 120);
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
    this.auth.register(value.displayName, value.email, value.password).subscribe({
      next: () => void this.router.navigate(['/sfu-forms']),
      error: (error: Error) => {
        this.error.set(error.message);
        this.busy.set(false);
      },
      complete: () => this.busy.set(false)
    });
  }
}
