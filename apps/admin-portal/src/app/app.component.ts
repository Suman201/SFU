import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { ThemeService } from './core/services/theme.service';

@Component({
  selector: 'sfu-admin-root',
  standalone: true,
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (auth.checking()) {
      <main class="auth-loading" aria-live="polite">
        <div>
          <span class="loader" aria-hidden="true"></span>
          <strong>Checking admin session</strong>
          <p>Restoring secure access.</p>
        </div>
      </main>
    }
    <router-outlet />
  `
})
export class AppComponent {
  protected readonly auth = inject(AuthService);

  constructor() {
    inject(ThemeService);
    this.auth.checkSession().subscribe();
  }
}
