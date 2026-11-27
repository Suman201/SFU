import { Component, DestroyRef, OnInit, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { CmsMedia, CmsMediaPage } from '@native-sfu/contracts';
import { CmsMediaApi } from '../../../core/services/cms-media-api.service';
import { AuthService } from '../../../core/services/auth.service';
import { ConfirmDialogService } from '../../../shared/confirm-dialog/confirm-dialog.service';
@Component({ standalone: true, selector: 'sfu-cms-media-picker', imports: [FormsModule], templateUrl: './cms-media-picker.html', styleUrl: './cms-media-picker.scss' })
export class CmsMediaPicker implements OnInit {
  protected readonly auth = inject(AuthService); private readonly api = inject(CmsMediaApi); private readonly confirm = inject(ConfirmDialogService);
  readonly choose = output<CmsMedia>(); readonly closed = output<void>();
  protected readonly list = signal<CmsMediaPage | null>(null); protected readonly previews = signal<Record<string, string>>({}); protected readonly error = signal(''); protected readonly busy = signal(false); protected readonly loading = signal(false);
  protected q = ''; protected archived = false; protected title = ''; protected altText = ''; protected uploadFile: File | null = null;
  protected edits: Record<string, { title: string; altText: string }> = {};
  private generation = 0; private alive = true;
  constructor() { inject(DestroyRef).onDestroy(() => { this.alive = false; this.generation++; this.release(); }); }
  ngOnInit(): void { void this.load(); }
  private release(): void { Object.values(this.previews()).forEach(url => URL.revokeObjectURL(url)); this.previews.set({}); }
  private message(error: unknown): string { return (error as { error?: { message?: string | string[] } })?.error?.message?.toString() || 'The media library could not be updated. Try again.'; }
  protected selectFile(event: Event): void { this.uploadFile = (event.target as HTMLInputElement).files?.[0] ?? null; }
  protected async load(page = 1): Promise<void> {
    const version = ++this.generation, owner = this.auth.user()?.id; this.loading.set(true); this.error.set('');
    try {
      const list = await firstValueFrom(this.api.list(page, this.q.trim(), this.archived)); if (!this.alive || version !== this.generation || owner !== this.auth.user()?.id) return;
      this.release(); this.list.set(list); this.edits = Object.fromEntries(list.items.map(row => [row.id, { title: row.title, altText: row.altText }]));
      await Promise.all(list.items.map(async row => { try { const bytes = await firstValueFrom(this.api.file(row.id)); if (this.alive && version === this.generation && owner === this.auth.user()?.id) { const url = URL.createObjectURL(bytes); this.previews.update(current => ({ ...current, [row.id]: url })); } } catch { /* Metadata stays readable when a file is temporarily unavailable. */ } }));
    } catch (error) { if (version === this.generation) this.error.set(this.message(error)); } finally { if (version === this.generation) this.loading.set(false); }
  }
  protected async upload(): Promise<void> {
    if (!this.uploadFile || this.busy() || this.title.trim().length < 2) { this.error.set('Choose an image and enter a descriptive title.'); return; }
    this.busy.set(true); this.error.set('');
    try { await firstValueFrom(this.api.upload(this.uploadFile, this.title.trim(), this.altText.trim())); this.uploadFile = null; this.title = ''; this.altText = ''; await this.load(); } catch (error) { this.error.set(this.message(error)); } finally { this.busy.set(false); }
  }
  protected async save(row: CmsMedia): Promise<void> {
    if (this.busy()) return; this.busy.set(true); this.error.set('');
    try { await firstValueFrom(this.api.update(row, this.edits[row.id]!)); await this.load(this.list()?.page); } catch (error) { this.error.set(this.message(error)); } finally { this.busy.set(false); }
  }
  protected async archive(row: CmsMedia): Promise<void> {
    if (this.busy() || !await this.confirm.confirm({ title: row.archived ? 'Restore this image?' : 'Archive this image?', message: 'Archiving hides an image from the picker. Published pages keep their existing image. Files are preserved.', confirmLabel: row.archived ? 'Restore image' : 'Archive image', variant: 'warning' })) return;
    this.busy.set(true); this.error.set('');
    try { await firstValueFrom(this.api.update(row, { archived: !row.archived })); await this.load(this.list()?.page); } catch (error) { this.error.set(this.message(error)); } finally { this.busy.set(false); }
  }
}
