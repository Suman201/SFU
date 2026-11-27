import { CmsMediaPicker } from '../media/cms-media-picker';
import type { CmsMedia } from '@native-sfu/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { DatePipe, TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { CMS_BLOCK_TYPES } from '@native-sfu/contracts';
import type {
  CmsAudience,
  CmsBlockType,
  CmsPage,
  CmsPageBlock,
  CmsPageRevision,
  CmsPageRevisionListResponse,
  CmsPageListQuery,
  CmsPageStatus,
  CmsPageType,
  CmsPageWriteRequest
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

type StatusFilter = CmsPageStatus | 'all';
type TypeFilter = CmsPageType | 'all';
type AudienceFilter = CmsAudience | 'all';

@Component({
  selector: 'sfu-cms-pages',
  standalone: true,
  imports: [CmsMediaPicker, DatePipe, ReactiveFormsModule, TitleCasePipe],
  templateUrl: './cms-pages.html',
  styleUrl: './cms-pages.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class CmsPages implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly mediaTarget = signal<{ blockId: string; entry?: number; signature?: string } | null>(null);
  protected readonly rows = signal<CmsPage[]>([]);
  protected readonly selected = signal<CmsPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly sectionTypes = CMS_BLOCK_TYPES;
  protected readonly publicationHistory = signal<CmsPageRevisionListResponse | null>(null);
  protected readonly selectedPublication = signal<CmsPageRevision | null>(null);
  protected readonly historyError = signal('');
  protected readonly historyLoading = signal(false);
  private historyGeneration = 0;
  protected readonly newSectionType = signal<CmsBlockType>('rich_text');
  protected readonly editorNotice = signal('');
  protected readonly editorError = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);

  protected readonly statusOptions: StatusFilter[] = ['all', 'draft', 'published', 'archived'];
  protected readonly pageTypes: TypeFilter[] = ['all', 'landing', 'page', 'legal', 'faq', 'announcement', 'banner'];
  protected readonly audiences: AudienceFilter[] = ['all', 'public', 'student', 'teacher', 'admin'];
  protected readonly editorPageTypes: CmsPageType[] = ['landing', 'page', 'legal', 'faq', 'announcement', 'banner'];
  protected readonly editorAudiences: CmsAudience[] = ['public', 'student', 'teacher', 'admin', 'all'];

  protected readonly filters = this.formBuilder.nonNullable.group({
    status: ['all' as StatusFilter],
    pageType: ['all' as TypeFilter],
    audience: ['all' as AudienceFilter],
    locale: [''],
    search: ['']
  });

  protected readonly form = this.formBuilder.nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(180)]],
    slug: ['', [Validators.required, Validators.maxLength(120)]],
    pageType: ['page' as CmsPageType],
    audience: ['public' as CmsAudience],
    locale: ['en', [Validators.required, Validators.maxLength(24)]],
    summary: ['', Validators.maxLength(500)],
    bodyMarkdown: ['', Validators.maxLength(20000)],
    sectionsJson: ['[]'],
    metaTitle: ['', Validators.maxLength(180)],
    metaDescription: ['', Validators.maxLength(300)],
    canonicalUrl: [''],
    tagsCsv: ['']
  });

  protected parsedSections(): CmsPageBlock[] {
    try {
      const parsed = JSON.parse(this.form.controls.sectionsJson.value || '[]') as unknown;
      return Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object' && !Array.isArray(item) && CMS_BLOCK_TYPES.includes(item.type) && ['links', 'items'].every(key => item[key] === undefined || (Array.isArray(item[key]) && item[key].every((entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry))))) ? (parsed as CmsPageBlock[]) : [];
    } catch {
      return [];
    }
  }

  protected addSection(type: CmsBlockType): void {
    this.mutateSections(sections => {
      if (sections.length >= 30) return;
      sections.push({ blockId: crypto.randomUUID(), type, title: '', body: '',
        ...(type === 'faq_list' || type === 'feature_grid' ? { items: [{ title: '', body: '' }] } : {}),
        ...(type === 'cta' || type === 'link_list' ? { links: [{ label: '', url: '/' }] } : {}) });
    });
  }

  protected openMedia(index: number, entry?: number): void {
    let blockId = ''; let signature: string | undefined;
    this.mutateSections(sections => { const section = sections[index]; if (!section) return; if (!section.blockId || sections.filter(value => value.blockId === section.blockId).length > 1) section.blockId = crypto.randomUUID(); blockId = section.blockId; if (entry !== undefined) signature = JSON.stringify(section.items?.[entry]); });
    if (blockId) this.mediaTarget.set({ blockId, entry, signature });
  }
  protected chooseImage(media: CmsMedia): void {
    const target = this.mediaTarget(); if (!target) return;
    this.mutateSections(sections => { const matches = sections.filter(value => value.blockId === target.blockId); const section = matches.length === 1 ? matches[0] : undefined; if (!section) throw new Error('Section changed.'); if (target.entry === undefined) { section.imageUrl = media.url; section.imageAlt = media.altText; } else { const item = section.items?.[target.entry]; if (!item || JSON.stringify(item) !== target.signature) throw new Error('Item changed.'); item.imageUrl = media.url; item.imageAlt = media.altText; } });
    this.mediaTarget.set(null);
  }

  protected updateSection(index: number, key: 'title' | 'eyebrow' | 'body' | 'imageUrl' | 'imageAlt', value: string): void {
    this.mutateSections(sections => { if (sections[index]) sections[index] = { ...sections[index], [key]: value }; });
  }

  protected moveSection(index: number, delta: number): void {
    this.mutateSections(sections => {
      const target = index + delta;
      if (target < 0 || target >= sections.length) return;
      [sections[index], sections[target]] = [sections[target]!, sections[index]!];
    });
  }

  protected removeSection(index: number): void { this.mutateSections(sections => { sections.splice(index, 1); }); }

  protected addSectionEntry(index: number, kind: 'links' | 'items'): void {
    this.mutateSections(sections => {
      const section = sections[index]; if (!section) return;
      if (kind === 'links' && (section.links?.length ?? 0) < 8) section.links = [...section.links ?? [], { label: '', url: '/' }];
      if (kind === 'items' && (section.items?.length ?? 0) < 24) section.items = [...section.items ?? [], { title: '', body: '' }];
    });
  }

  protected updateSectionEntry(index: number, kind: 'links' | 'items', entry: number, key: string, value: string): void {
    this.mutateSections(sections => { const item = sections[index]?.[kind]?.[entry]; if (item) Object.assign(item, { [key]: value }); });
  }

  protected removeSectionEntry(index: number, kind: 'links' | 'items', entry: number): void {
    this.mutateSections(sections => { sections[index]?.[kind]?.splice(entry, 1); });
  }

  private mutateSections(mutate: (sections: CmsPageBlock[]) => void): void {
    if (!this.auth.can('admin:content:write')) return;
    try {
      const sections: unknown = JSON.parse(this.form.controls.sectionsJson.value || '[]');
      if (!Array.isArray(sections) || sections.some(section => !section || typeof section !== 'object' || !CMS_BLOCK_TYPES.includes(section.type))) throw new Error('Correct the advanced section JSON before using section controls.');
      mutate(sections as CmsPageBlock[]);
      this.form.controls.sectionsJson.setValue(JSON.stringify(sections, null, 2));
      this.form.controls.sectionsJson.markAsDirty(); this.editorError.set('');
    } catch { this.editorError.set('Correct the advanced section JSON before using section controls.'); }
  }

  ngOnInit(): void {
    this.load();
    this.startNew();
  }

  protected applyFilters(): void {
    this.load(1);
  }

  protected resetFilters(): void {
    this.filters.reset({ status: 'all', pageType: 'all', audience: 'all', locale: '', search: '' });
    this.load(1);
  }

  protected nextPage(): void {
    if (this.page() * this.limit() < this.total()) {
      this.load(this.page() + 1);
    }
  }

  protected previousPage(): void {
    if (this.page() > 1) {
      this.load(this.page() - 1);
    }
  }

  protected startNew(): void {
    if (!this.auth.can('admin:content:write')) return;
    this.historyGeneration++; this.publicationHistory.set(null); this.selectedPublication.set(null); this.historyError.set(''); this.historyLoading.set(false); this.editorNotice.set('');
    this.selected.set(null);
    this.editorError.set('');
    this.form.reset({
      title: '',
      slug: '',
      pageType: 'page',
      audience: 'public',
      locale: 'en',
      summary: '',
      bodyMarkdown: '',
      sectionsJson: '[]',
      metaTitle: '',
      metaDescription: '',
      canonicalUrl: '',
      tagsCsv: ''
    });
  }

  protected edit(row: CmsPage): void {
    this.historyGeneration++; this.publicationHistory.set(null); this.selectedPublication.set(null); this.historyError.set(''); this.historyLoading.set(false); this.editorNotice.set('');
    this.selected.set(row);
    this.editorError.set('');
    this.form.reset({
      title: row.title,
      slug: row.slug,
      pageType: row.pageType,
      audience: row.audience,
      locale: row.locale || 'en',
      summary: row.summary || '',
      bodyMarkdown: row.bodyMarkdown || '',
      sectionsJson: JSON.stringify(row.sections || [], null, 2),
      metaTitle: row.seo?.metaTitle || '',
      metaDescription: row.seo?.metaDescription || '',
      canonicalUrl: row.seo?.canonicalUrl || '',
      tagsCsv: (row.tags || []).join(', ')
    });
  }

  protected save(): void {
    if (!this.auth.can('admin:content:write')) return;
    this.editorError.set('');
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.editorError.set('Complete the required CMS fields before saving.');
      return;
    }
    const payload = this.toPayload();
    if (!payload) {
      return;
    }
    this.saving.set(true);
    const current = this.selected();
    const request = current ? this.api.updateCmsPage(current.pageId, payload) : this.api.createCmsPage(payload);
    request.pipe(finalize(() => this.saving.set(false))).subscribe({
      next: (page) => {
        this.selected.set(page);
        this.edit(page);
        this.load(this.page());
      },
      error: (error: unknown) => this.editorError.set(this.api.apiErrorMessage(error))
    });
  }

  protected publish(row = this.selected()): void {
    if (!this.auth.can('admin:content:write')) return;
    if (row && this.selected()?.pageId === row.pageId && this.form.dirty) { this.editorError.set('Save your draft before publishing.'); return; }
    if (row) {
      this.runAction(row, 'publish');
    }
  }

  protected unpublish(row = this.selected()): void {
    if (!this.auth.can('admin:content:write')) return;
    if (row) {
      this.runAction(row, 'unpublish');
    }
  }

  protected archive(row = this.selected()): void {
    if (!this.auth.can('admin:content:write')) return;
    if (row) {
      this.runAction(row, 'archive');
    }
  }

  protected loadPublications(page = 1): void {
    const current = this.selected(); if (!current) return;
    const generation = ++this.historyGeneration;
    this.historyLoading.set(true); this.historyError.set('');
    this.api.listCmsRevisions(current.pageId, page).subscribe({
      next: history => { if (generation === this.historyGeneration) { this.publicationHistory.set(history); this.historyLoading.set(false); } },
      error: error => { if (generation === this.historyGeneration) { this.historyError.set(this.api.apiErrorMessage(error)); this.historyLoading.set(false); } }
    });
  }
  protected viewPublication(revisionId: string): void {
    const current = this.selected(); if (!current) return;
    const generation = ++this.historyGeneration; this.historyLoading.set(false); this.historyError.set('');
    this.api.getCmsRevision(current.pageId, revisionId).subscribe({
      next: revision => { if (generation === this.historyGeneration) this.selectedPublication.set(revision); },
      error: error => { if (generation === this.historyGeneration) this.historyError.set(this.api.apiErrorMessage(error)); }
    });
  }
  protected restorePublication(): void {
    const current = this.selected(), revision = this.selectedPublication();
    if (!current || !revision || !this.auth.can('admin:content:write') || this.saving()) return;
    if (this.form.dirty) { this.editorError.set('Save your current draft before restoring a publication.'); return; }
    this.saving.set(true);
    this.api.restoreCmsRevision(current.pageId, revision.revisionId, current.revision ?? 0).pipe(finalize(() => this.saving.set(false))).subscribe({
      next: page => { this.edit(page); this.editorNotice.set('Publication restored to the draft. Review and publish it when ready.'); this.load(this.page()); },
      error: error => this.editorError.set(this.api.apiErrorMessage(error))
    });
  }

  protected statusClass(status: CmsPageStatus): string {
    return `status-${status}`;
  }

  protected trackByPage(_index: number, page: CmsPage): string {
    return page.pageId;
  }

  protected publicPath(page: CmsPage): string {
    return page.slug === 'home' ? '/' : ['about', 'contact-us', 'faq', 'help', 'terms', 'privacy-policy', 'refund-policy'].includes(page.slug) ? `/${page.slug}` : `/pages/${encodeURIComponent(page.slug)}`;
  }

  protected sectionLabel(section: CmsPageBlock): string {
    return [section.type.replace(/_/g, ' '), section.title].filter(Boolean).join(' · ');
  }

  private load(page = this.page()): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .listCmsPages(this.toQuery(page))
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (response) => {
          this.rows.set(response.items);
          this.page.set(response.page);
          this.limit.set(response.limit);
          this.total.set(response.total);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private runAction(row: CmsPage, action: 'publish' | 'unpublish' | 'archive'): void {
    this.editorError.set('');
    this.saving.set(true);
    const request =
      action === 'publish' ? this.api.publishCmsPage(row.pageId, row.revision) : action === 'unpublish' ? this.api.unpublishCmsPage(row.pageId) : this.api.archiveCmsPage(row.pageId);
    request.pipe(finalize(() => this.saving.set(false))).subscribe({
      next: (page) => {
        this.selected.set(page);
        this.edit(page);
        this.load(this.page());
      },
      error: (error: unknown) => this.editorError.set(this.api.apiErrorMessage(error))
    });
  }

  private toQuery(page: number): CmsPageListQuery {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: this.limit(),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.pageType !== 'all' ? { pageType: value.pageType } : {}),
      ...(value.audience !== 'all' ? { audience: value.audience } : {}),
      ...(value.locale.trim() ? { locale: value.locale.trim() } : {}),
      ...(value.search.trim() ? { search: value.search.trim() } : {})
    };
  }

  private toPayload(): CmsPageWriteRequest | null {
    let sections: CmsPageBlock[];
    try {
      const parsed = JSON.parse(this.form.controls.sectionsJson.value || '[]') as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Sections must be a JSON array.');
      }
      sections = parsed as CmsPageBlock[];
    } catch (error) {
      this.editorError.set(error instanceof Error ? error.message : 'Sections JSON is invalid.');
      return null;
    }
    const value = this.form.getRawValue();
    return {
      ...(this.selected() ? { expectedRevision: this.selected()!.revision ?? 0 } : {}),
      title: value.title,
      slug: value.slug,
      pageType: value.pageType,
      audience: value.audience,
      locale: value.locale,
      summary: value.summary,
      bodyMarkdown: value.bodyMarkdown,
      sections,
      seo: {
        metaTitle: value.metaTitle,
        metaDescription: value.metaDescription,
        ...(value.canonicalUrl.trim() ? { canonicalUrl: value.canonicalUrl.trim() } : {})
      },
      tags: value.tagsCsv
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    };
  }
}
