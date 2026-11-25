import {
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import type {
  AdminWhiteboardReview,
  WhiteboardMemorySnapshot,
} from '@native-sfu/contracts';
import { Whiteboard } from '../../../../../frontend/src/app/shared/whiteboard/whiteboard';
import {
  AdminOperationsApi,
  adminOperationError,
  saveAdminBlob,
} from '../../core/services/admin-operations-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
@Component({
  selector: 'sfu-admin-whiteboards',
  standalone: true,
  imports: [FormsModule, RouterLink, Whiteboard],
  templateUrl: './whiteboards.html',
  styleUrls: ['../../shared/admin-operations.scss', './whiteboards.scss'],
})
export class AdminWhiteboards {
  private readonly api = inject(AdminOperationsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly confirm = inject(ConfirmDialogService);
  protected readonly auth = inject(AuthService);
  protected readonly board = viewChild(Whiteboard);
  protected readonly list = signal<{
    items: Array<{
      sessionId: string;
      batchId: string;
      title: string;
      teacherId: string;
      status: string;
      pageCount: number;
      elementCount: number;
      updatedAt: string;
    }>;
    total: number;
    page: number;
    limit: number;
  }>({ items: [], total: 0, page: 1, limit: 25 });
  protected readonly review = signal<AdminWhiteboardReview | null>(null);
  protected readonly snapshot = signal<WhiteboardMemorySnapshot | null>(null);
  protected readonly selectedVersion = signal('');
  protected readonly renderKey = signal(0);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected search = '';
  protected page = 1;
  protected reason = '';
  protected sessionId = '';
  private requestVersion = 0;
  protected readonly entries = computed(() => {
    const snapshot = this.snapshot();
    return snapshot ? [{ key: this.renderKey(), snapshot }] : [];
  });
  constructor() {
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe((params) => {
        this.sessionId = params.get('sessionId') || '';
        if (this.sessionId) this.loadReview();
      });
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe((params) => {
        if (!this.sessionId) {
          this.search = params.get('search') || '';
          this.page = Number(params.get('page') || 1);
          this.loadList();
        }
      });
  }
  protected loadList() {
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.api
      .whiteboards(this.search, this.page)
      .pipe(
        finalize(() => {
          if (version === this.requestVersion) this.loading.set(false);
        }),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (value) => {
          if (version === this.requestVersion) {
            this.list.set(value);
            this.error.set('');
          }
        },
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected apply() {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { search: this.search, page: 1 },
    });
  }
  protected changePage(change: number) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { search: this.search, page: this.list().page + change },
    });
  }
  protected loadReview() {
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.api
      .whiteboard(this.sessionId)
      .pipe(
        finalize(() => {
          if (version === this.requestVersion) this.loading.set(false);
        }),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (value) => {
          if (version !== this.requestVersion) return;
          this.review.set(value);
          this.selectedVersion.set('');
          this.snapshot.set(value.board?.snapshot ?? null);
          this.renderKey.update((key) => key + 1);
          this.error.set('');
        },
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected preview(versionId: string) {
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.api
      .boardVersion(this.sessionId, versionId)
      .pipe(
        finalize(() => {
          if (version === this.requestVersion) this.loading.set(false);
        }),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (value) => {
          if (version === this.requestVersion) {
            this.selectedVersion.set(versionId);
            this.snapshot.set(value.snapshot);
            this.renderKey.update((key) => key + 1);
            this.error.set('');
          }
        },
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected current() {
    ++this.requestVersion;
    this.selectedVersion.set('');
    this.snapshot.set(this.review()?.board?.snapshot ?? null);
    this.renderKey.update((key) => key + 1);
  }
  protected async export(format: 'png' | 'pdf' | 'json') {
    if (format === 'json') {
      this.api
        .boardJson(this.sessionId, this.selectedVersion() || undefined)
        .pipe(takeUntilDestroyed(this.destroy))
        .subscribe({
          next: (blob) =>
            saveAdminBlob(blob, 'whiteboard-' + this.sessionId + '.json'),
          error: (error) => this.error.set(adminOperationError(error)),
        });
    } else {
      try {
        await this.board()?.exportForReview(format);
      } catch (error) {
        this.error.set(adminOperationError(error));
      }
    }
  }
  protected async restore() {
    const state = this.review()?.board,
      versionId = this.selectedVersion();
    if (!state || !versionId || this.busy() || this.reason.trim().length < 5)
      return;
    if (
      !(await this.confirm.confirm({
        title: 'Restore this whiteboard version?',
        message:
          'The current board will be backed up before replacement. The class must not be live; a changed board requires a fresh review.',
        confirmLabel: 'Back up and restore',
        variant: 'danger',
      }))
    )
      return;
    this.busy.set(true);
    this.api
      .restoreBoard(this.sessionId, versionId, {
        expectedSnapshotVersion: state.snapshotVersion,
        expectedLastOperationSeq: state.lastOperationSeq ?? 0,
        reason: this.reason.trim(),
      })
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: (value) => {
          this.review.set(value);
          this.snapshot.set(value.board?.snapshot ?? null);
          this.selectedVersion.set('');
          this.renderKey.update((key) => key + 1);
          this.reason = '';
          this.notice.set(
            'Whiteboard restored. The previous board is preserved as a checkpoint.',
          );
        },
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected date(value: string) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }
}
