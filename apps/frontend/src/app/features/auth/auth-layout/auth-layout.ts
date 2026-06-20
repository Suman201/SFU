import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { AuthRole } from '../../../core/services/auth.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

@Component({
  selector: 'sfu-auth-layout',
  standalone: true,
  imports: [Footer, Header],
  templateUrl: './auth-layout.html',
  styleUrl: './auth-layout.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class AuthLayout {
  @Input({ required: true }) role!: AuthRole;
  @Input({ required: true }) title!: string;
  @Input() subtitle = '';

  protected get roleLabel(): string {
    return this.role === 'teacher' ? 'Teacher' : 'Student';
  }

  protected get dashboardLabel(): string {
    return this.role === 'teacher' ? 'Batch dashboard' : 'Student dashboard';
  }
}
