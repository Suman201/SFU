import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';
import {
  EUROPEAN_MARKETS,
  type TeachingCatalogKind,
  type TeachingCatalogEntry,
} from '@native-sfu/contracts';
import { TeachingCatalogApi } from '../../core/services/teaching-catalog-api.service';
@Component({
  selector: 'sfu-teaching-catalog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './teaching-catalog.html',
  styleUrl: './teaching-catalog.scss',
})
export class TeachingCatalogAdmin implements OnInit {
  protected readonly api = inject(TeachingCatalogApi);
  protected readonly kind = signal<TeachingCatalogKind>('category');
  protected readonly tabs = [
    { id: 'category' as const, label: 'Categories' },
    { id: 'subject' as const, label: 'Subjects' },
    { id: 'curriculum' as const, label: 'Curricula' },
  ];
  protected readonly title = computed(
    () => this.tabs.find((tab) => tab.id === this.kind())!.label,
  );
  protected readonly rows = signal<TeachingCatalogEntry[]>([]);
  protected readonly categories = signal<TeachingCatalogEntry[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly page = signal(1);
  protected readonly total = signal(0);
  protected readonly editor = signal(false);
  protected readonly markets = EUROPEAN_MARKETS;
  protected query = '';
  protected status = 'all';
  protected category = '';
  protected selected: TeachingCatalogEntry | null = null;
  protected form = {
    assessmentType:
      'knowledge_review' as import('@native-sfu/contracts').CategoryAssessmentType,
    assessmentInstructions: '',
    name: '',
    description: '',
    parentId: '',
    aliases: '',
    countryCodes: [] as string[],
    sortOrder: 0,
    status: 'active' as 'active' | 'archived',
  };
  ngOnInit() {
    this.reload();
    this.loadCategories();
  }
  protected countryName(code: string) {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  }
  protected loadCategories() {
    this.api.snapshot().subscribe({
      next: (r) => this.categories.set(r.categories),
      error: (e) => this.error.set(this.api.error(e)),
    });
  }
  protected switchKind(kind: TeachingCatalogKind) {
    if (this.saving()) return;
    this.kind.set(kind);
    this.page.set(1);
    this.query = '';
    this.category = '';
    this.editor.set(false);
    this.reload();
  }
  protected search() {
    this.page.set(1);
    this.reload();
  }
  protected reload() {
    if (this.loading()) return;
    this.loading.set(true);
    this.error.set('');
    this.api
      .list({
        kind: this.kind(),
        page: String(this.page()),
        limit: '25',
        q: this.query,
        status: this.status,
        ...(this.category ? { parentId: this.category } : {}),
      })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (r) => {
          this.rows.set(r.items);
          this.total.set(r.total);
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected goPage(delta: number) {
    this.page.update((p) => p + delta);
    this.reload();
  }
  protected edit(row: TeachingCatalogEntry | null) {
    this.selected = row;
    this.form = {
      assessmentType: row?.assessmentType ?? 'knowledge_review',
      assessmentInstructions:
        row?.assessmentInstructions ??
        'Explain a concept, include a worked example, and describe how you check understanding.',
      name: row?.name ?? '',
      description: row?.description ?? '',
      parentId: row?.parentId ?? '',
      aliases: row?.aliases.join(', ') ?? '',
      countryCodes: [...(row?.countryCodes ?? [])],
      sortOrder: row?.sortOrder ?? 0,
      status: row?.status ?? 'active',
    };
    this.editor.set(true);
    this.error.set('');
  }
  protected save() {
    if (this.saving() || !this.form.name.trim()) return;
    this.saving.set(true);
    this.error.set('');
    const body = {
      ...(this.kind() === 'category'
        ? {
            assessmentType: this.form.assessmentType,
            assessmentInstructions: this.form.assessmentInstructions,
          }
        : {}),
      name: this.form.name,
      description: this.form.description,
      aliases: this.form.aliases
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      sortOrder: this.form.sortOrder,
      status: this.form.status,
      ...(this.kind() === 'subject' ? { parentId: this.form.parentId } : {}),
      countryCodes: this.kind() === 'curriculum' ? this.form.countryCodes : [],
      ...(this.selected ? { version: this.selected.version } : {}),
    };
    this.api
      .save(this.kind(), this.selected?.id ?? null, body)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.editor.set(false);
          this.notice.set('Catalogue saved.');
          this.reload();
          this.loadCategories();
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected archive(row: TeachingCatalogEntry) {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.api
      .save(row.kind, row.id, {
        name: row.name,
        description: row.description,
        parentId: row.parentId,
        aliases: row.aliases,
        countryCodes: row.countryCodes,
        sortOrder: row.sortOrder,
        version: row.version,
        status: row.status === 'active' ? 'archived' : 'active',
      })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.notice.set(
            row.status === 'active'
              ? 'Entry archived. Existing teacher records are retained.'
              : 'Entry restored.',
          );
          this.reload();
          this.loadCategories();
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected starter() {
    if (this.saving()) return;
    this.saving.set(true);
    this.api
      .starter()
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.notice.set('Starter entries added. Existing changes were kept.');
          this.reload();
          this.loadCategories();
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected categoryName(id?: string) {
    return (
      this.categories().find((x) => x.id === id)?.name ?? 'Archived category'
    );
  }
}
