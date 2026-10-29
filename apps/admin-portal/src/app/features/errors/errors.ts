import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import type { ErrorIncident, ErrorIncidentPage } from '@native-sfu/contracts';
import { API_BASE_URL } from '../../core/services/app-environment';
@Component({
  selector: 'sfu-admin-errors',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './errors.html',
  styleUrl: './errors.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ErrorsAdmin {
  private readonly http = inject(HttpClient);
  private readonly base = API_BASE_URL + '/admin/errors';
  readonly rows = signal<ErrorIncident[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly loading = signal(false);
  readonly selected = signal<ErrorIncident | null>(null);
  readonly saving = signal(false);
  readonly message = signal('');
  readonly failure = signal('');
  readonly copied = signal(false);
  status = 'all';
  source = 'all';
  reference =
    inject(ActivatedRoute)
      .snapshot.queryParamMap.get('reference')
      ?.slice(0, 128) ?? '';
  private version = 0;
  private detailVersion = 0;
  constructor() {
    this.load();
  }
  load(page = 1): void {
    const version = ++this.version;
    this.loading.set(true);
    this.failure.set('');
    this.page.set(page);
    this.http
      .get<{
        data: ErrorIncidentPage;
      }>(this.base, { params: { page, status: this.status, source: this.source, reference: this.reference.trim() } })
      .subscribe({
        next: ({ data }) => {
          if (version !== this.version) return;
          this.rows.set(data.items);
          this.total.set(data.total);
          this.loading.set(false);
        },
        error: () => {
          if (version !== this.version) return;
          this.loading.set(false);
          this.failure.set(
            'The error log could not load. Check the connection and refresh.',
          );
        },
      });
  }
  open(item: ErrorIncident): void {
    const version = ++this.detailVersion;
    this.message.set('');
    this.failure.set('');
    this.copied.set(false);
    this.http
      .get<{ data: ErrorIncident }>(`${this.base}/${item.id}`)
      .subscribe({
        next: ({ data }) => {
          if (version === this.detailVersion) this.selected.set(data);
        },
        error: () =>
          this.failure.set(
            'This error record could not be opened. Refresh and try again.',
          ),
      });
  }
  close(): void {
    if (this.saving()) return;
    this.detailVersion++;
    this.selected.set(null);
  }
  update(): void {
    const item = this.selected();
    if (!item || this.saving()) return;
    this.saving.set(true);
    this.message.set('');
    this.failure.set('');
    this.http
      .patch<{
        data: ErrorIncident;
      }>(`${this.base}/${item.id}`, { status: item.status === 'open' ? 'resolved' : 'open' })
      .subscribe({
        next: ({ data }) => {
          this.saving.set(false);
          this.selected.set(data);
          this.message.set(
            data.status === 'resolved'
              ? 'Error marked as resolved.'
              : 'Error reopened.',
          );
          this.load(this.page());
        },
        error: () => {
          this.saving.set(false);
          this.failure.set('The status could not be saved. Try again.');
        },
      });
  }
  async copy(): Promise<void> {
    const item = this.selected();
    if (!item) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(item, null, 2));
      this.copied.set(true);
    } catch {
      this.failure.set(
        'Clipboard access is blocked. Select and copy the reference below.',
      );
    }
  }
}
