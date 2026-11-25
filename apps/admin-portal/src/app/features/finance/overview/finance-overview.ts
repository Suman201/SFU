import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { FinanceOverview, PaymentGatewayStatus } from '@native-sfu/contracts';
import { FinanceApi, financeError } from '../../../core/services/finance-api.service';
import { FinanceTabs } from '../finance-tabs';
import { isoDay, money } from '../finance-shared';

@Component({
  selector: 'sfu-finance-overview',
  standalone: true,
  imports: [FormsModule, RouterLink, FinanceTabs],
  templateUrl: './finance-overview.html',
  styleUrl: '../finance.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinanceOverviewPage implements OnInit {
  private readonly api = inject(FinanceApi);
  protected readonly data = signal<FinanceOverview | null>(null);
  protected readonly gateway = signal<PaymentGatewayStatus | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly from = signal(isoDay(-29));
  protected readonly to = signal(isoDay());
  protected readonly money = money;

  protected readonly chart = computed(() => {
    const data = this.data();
    if (!data) return [];
    const byDay = new Map(data.daily.map((point) => [point.date, point]));
    const days: Array<{ date: string; grossMinor: number }> = [];
    const start = new Date(`${data.from}T00:00:00Z`).getTime();
    const end = new Date(`${data.to}T00:00:00Z`).getTime();
    for (let at = start; at <= end && days.length < 400; at += 86_400_000) {
      const date = new Date(at).toISOString().slice(0, 10);
      days.push({ date, grossMinor: byDay.get(date)?.grossMinor ?? 0 });
    }
    const max = Math.max(1, ...days.map((day) => day.grossMinor));
    return days.map((day) => ({ ...day, height: day.grossMinor ? Math.max(4, Math.round((day.grossMinor / max) * 100)) : 2 }));
  });

  ngOnInit(): void {
    this.api.status().subscribe({ next: (status) => this.gateway.set(status), error: () => undefined });
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api.overview({ from: this.from(), to: this.to() }).subscribe({
      next: (data) => {
        this.data.set(data);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(financeError(error, 'Finance overview could not be loaded.'));
        this.loading.set(false);
      },
    });
  }

  protected preset(days: number): void {
    this.from.set(isoDay(-(days - 1)));
    this.to.set(isoDay());
    this.load();
  }

  protected barTitle(point: { date: string; grossMinor: number }): string {
    return `${point.date}: ${money(point.grossMinor, this.data()?.currency ?? 'USD')}`;
  }
}
