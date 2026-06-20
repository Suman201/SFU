import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { ThemeService } from './core/services/theme.service';

@Component({
  selector: 'sfu-root',
  standalone: true,
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (auth.checking()) {
      <main class="auth-loading" aria-live="polite">
        <div>
          <span class="loader" aria-hidden="true"></span>
          <strong>Checking your session</strong>
          <p>Restoring your workspace securely.</p>
        </div>
      </main>
    }
    <router-outlet />
  `,
  styles: [
    `
      .auth-loading {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: grid;
        place-items: center;
        background: color-mix(in srgb, var(--bg) 92%, transparent);
        backdrop-filter: blur(10px);
      }

      .auth-loading > div {
        display: grid;
        gap: 8px;
        justify-items: center;
        padding: 20px;
        border: 1px solid var(--line-soft);
        border-radius: var(--radius);
        background: var(--panel-elevated);
        box-shadow: var(--shadow-md);
      }

      .loader {
        width: 28px;
        height: 28px;
        border: 3px solid color-mix(in srgb, var(--success) 20%, var(--line));
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: auth-spin 800ms linear infinite;
      }

      strong {
        color: var(--text);
      }

      p {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
      }

      @keyframes auth-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `
  ]
})
export class AppComponent {
  protected readonly auth = inject(AuthService);

  constructor() {
    inject(ThemeService);
    this.auth.checkSession().subscribe();
  }
}
