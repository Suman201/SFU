import { AuthService } from '../../../core/services/auth.service';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { TeacherFinanceRow } from '@native-sfu/contracts';
import { FinanceApi, financeError } from '../../../core/services/finance-api.service';
import { FinanceTabs } from '../finance-tabs';
import { initials, money } from '../finance-shared';

@Component({
  selector: 'sfu-finance-teachers',
  standalone: true,
  imports: [FormsModule, RouterLink, FinanceTabs],
  templateUrl: './finance-teachers.html',
  styleUrl: '../finance.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FinanceTeachersPage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(FinanceApi);
  private readonly route = inject(ActivatedRoute);
  protected readonly rows = signal<TeacherFinanceRow[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly q = signal('');
  protected readonly money = money;
  protected readonly initials = initials;
  protected readonly totals = computed(() => {
    const rows = this.rows();
    const sum = (key: keyof TeacherFinanceRow) => rows.reduce((total, row) => total + (row[key] as number), 0);
    return {
      currency: rows[0]?.currency ?? 'USD',
      gross: sum('grossMinor'),
      commission: sum('commissionMinor'),
      owed: sum('pendingMinor') + sum('availableMinor') + sum('reservedMinor') + sum('frozenMinor'),
      paidOut: sum('paidOutMinor'),
    };
  });

  ngOnInit(): void {
    this.q.set(this.route.snapshot.queryParamMap.get('q') ?? '');
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api.teachers({ q: this.q().trim() }).subscribe({
      next: (rows) => {
        this.rows.set(rows);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(financeError(error, 'Teacher earnings could not be loaded.'));
        this.loading.set(false);
      },
    });
  }
}
