import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  PAYMENT_CURRENCIES,
  PAYMENT_CURRENCY_CODES,
  bpsToPercentLabel,
  formatMoney,
  fromMinorUnits,
  splitCommission,
  toMinorUnits,
  type FinanceSettings,
  type PaymentCurrency,
  type PaymentGatewayStatus,
} from '@native-sfu/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { FinanceApi, financeError } from '../../../core/services/finance-api.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
import { FinanceTabs } from '../finance-tabs';

interface OverrideRow {
  teacherId: string;
  teacherName?: string;
  percent: string;
}

@Component({
  selector: 'sfu-finance-settings',
  standalone: true,
  imports: [FormsModule, FinanceTabs],
  templateUrl: './finance-settings.html',
  styleUrl: '../finance.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinanceSettingsPage implements OnInit {
  private readonly api = inject(FinanceApi);
  private readonly auth = inject(AuthService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  protected readonly settings = signal<FinanceSettings | null>(null);
  protected readonly gateway = signal<PaymentGatewayStatus | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly saving = signal(false);
  protected readonly commission = signal('15');
  protected readonly holdDays = signal('7');
  protected readonly minimumPayout = signal('20.00');
  protected readonly currencies = signal<PaymentCurrency[]>(['USD']);
  protected readonly overrides = signal<OverrideRow[]>([]);
  protected readonly codes = PAYMENT_CURRENCY_CODES;
  protected readonly definitions = PAYMENT_CURRENCIES;
  protected readonly superAdmin = computed(() => (this.auth.user()?.roles ?? []).map((role) => role.toUpperCase()).includes('SUPER_ADMIN'));

  protected readonly example = computed(() => {
    const bps = this.percentToBps(this.commission());
    if (bps === null) return null;
    const split = splitCommission(10_000, bps);
    return { platform: formatMoney(split.commissionMinor, 'USD'), teacher: formatMoney(split.teacherMinor, 'USD') };
  });

  ngOnInit(): void {
    this.api.status().subscribe({ next: (status) => this.gateway.set(status), error: () => undefined });
    this.load();
  }

  private load(): void {
    this.api.settings().subscribe({
      next: (settings) => this.apply(settings),
      error: (error) => this.error.set(financeError(error, 'Finance settings could not be loaded.')),
    });
  }

  private apply(settings: FinanceSettings): void {
    this.settings.set(settings);
    this.commission.set(String(settings.commissionBps / 100));
    this.holdDays.set(String(settings.holdDays));
    this.minimumPayout.set(fromMinorUnits(settings.minimumPayoutMinor, settings.defaultCurrency).toFixed(2));
    this.currencies.set([...settings.enabledCurrencies]);
    this.overrides.set(settings.teacherOverrides.map((item) => ({ teacherId: item.teacherId, teacherName: item.teacherName, percent: String(item.commissionBps / 100) })));
  }

  private percentToBps(value: string): number | null {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 100) return null;
    const bps = Math.round(number * 100);
    return Math.abs(bps / 100 - number) < 1e-9 ? bps : null;
  }

  protected toggleCurrency(code: PaymentCurrency, enabled: boolean): void {
    this.currencies.update((list) => (enabled ? [...new Set([...list, code])] : list.filter((item) => item !== code)));
  }

  protected addOverride(): void {
    this.overrides.update((list) => [...list, { teacherId: '', percent: this.commission() }]);
  }

  protected updateOverride(index: number, patch: Partial<OverrideRow>): void {
    this.overrides.update((list) => list.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  }

  protected removeOverride(index: number): void {
    this.overrides.update((list) => list.filter((_, position) => position !== index));
  }

  protected percentLabel(bps: number): string {
    return bpsToPercentLabel(bps);
  }

  protected async save(): Promise<void> {
    const current = this.settings();
    if (!current) return;
    const commissionBps = this.percentToBps(this.commission());
    const holdDays = Number(this.holdDays());
    const minimum = Number(this.minimumPayout());
    if (commissionBps === null) return this.error.set('Commission must be between 0 and 100 with at most two decimals.');
    if (!Number.isInteger(holdDays) || holdDays < 0 || holdDays > 90) return this.error.set('Holding period must be 0–90 whole days.');
    if (!Number.isFinite(minimum) || minimum < 1) return this.error.set('Minimum payout must be at least 1.00.');
    const teacherOverrides = [];
    for (const row of this.overrides()) {
      const bps = this.percentToBps(row.percent);
      if (!row.teacherId.trim() || bps === null) return this.error.set('Each override needs a teacher ID and a valid percentage.');
      teacherOverrides.push({ teacherId: row.teacherId.trim(), commissionBps: bps });
    }
    if (commissionBps !== current.commissionBps) {
      const confirmed = await this.confirmDialog.confirm({
        title: 'Change platform commission?',
        message: `New payments will use ${bpsToPercentLabel(commissionBps)} instead of ${bpsToPercentLabel(current.commissionBps)}. Payments already made keep the rate captured at checkout.`,
        confirmLabel: 'Save commission',
        variant: 'warning',
      });
      if (!confirmed) return;
    }
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.api
      .saveSettings({
        version: current.version,
        commissionBps,
        holdDays,
        minimumPayoutMinor: toMinorUnits(minimum, current.defaultCurrency),
        enabledCurrencies: this.currencies(),
        teacherOverrides,
      })
      .subscribe({
        next: (settings) => {
          this.saving.set(false);
          this.apply(settings);
          this.success.set('Finance settings saved. Changes apply to new payments; every change is in the audit log.');
        },
        error: (error) => {
          this.saving.set(false);
          this.error.set(financeError(error, 'Settings could not be saved.'));
        },
      });
  }
}
