import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'sfu-finance-tabs',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav class="view-tabs" aria-label="Finance sections">
      @for (tab of tabs; track tab.path) {
        <a [routerLink]="tab.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: tab.exact }" ariaCurrentWhenActive="page">{{ tab.label }}</a>
      }
    </nav>
  `,
  styleUrl: './finance.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinanceTabs {
  protected readonly tabs = [
    { label: 'Overview', path: '/finance', exact: true },
    { label: 'Payments', path: '/finance/payments', exact: false },
    { label: 'Payouts', path: '/finance/payouts', exact: false },
    { label: 'Refunds & disputes', path: '/finance/refunds', exact: false },
    { label: 'Teacher earnings', path: '/finance/teachers', exact: false },
    { label: 'Ledger & reconciliation', path: '/finance/ledger', exact: false },
    { label: 'Settings', path: '/finance/settings', exact: false },
  ];
}
