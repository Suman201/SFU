import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'sfu-admin-forbidden',
  standalone: true,
  imports: [RouterLink],
  template: `
    <main class="state-page">
      <section>
        <p class="eyebrow">Access limited</p>
        <h1>Admin access required</h1>
        <p>This workspace is available only to admin and super admin accounts.</p>
        <button type="button" (click)="logout()">Use another account</button>
        <a routerLink="/login">Back to login</a>
      </section>
    </main>
  `,
  styles: [
    `
      .state-page {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--bg);
      }

      section {
        width: min(100%, 440px);
        display: grid;
        gap: 12px;
        padding: 26px;
        border: 1px solid var(--line);
        border-radius: 18px;
        background: var(--panel-elevated);
        box-shadow: var(--shadow-md);
      }

      h1,
      p {
        margin: 0;
      }

      h1 {
        color: var(--text);
      }

      p {
        color: var(--muted);
      }

      .eyebrow {
        color: var(--product-rose);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      button,
      a {
        width: fit-content;
        min-height: 38px;
        display: inline-flex;
        align-items: center;
        border-radius: 10px;
        font-weight: 800;
      }

      button {
        border: 0;
        padding: 0 14px;
        color: white;
        background: var(--product-rose);
        cursor: pointer;
      }

      a {
        color: var(--product-green);
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.Eager
})
export class AdminForbidden {
  private readonly auth = inject(AuthService);

  protected logout(): void {
    this.auth.logout();
  }
}
