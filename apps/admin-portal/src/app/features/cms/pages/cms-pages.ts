import { DatePipe, TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import type {
  CmsAudience,
  CmsPage,
  CmsPageBlock,
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
  imports: [DatePipe, ReactiveFormsModule, TitleCasePipe],
  templateUrl: './cms-pages.html',
  styleUrl: './cms-pages.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class CmsPages implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly rows = signal<CmsPage[]>([]);
  protected readonly selected = signal<CmsPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
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
      return Array.isArray(parsed) ? (parsed as CmsPageBlock[]) : [];
    } catch {
      return [];
    }
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
    if (row) {
      this.runAction(row, 'publish');
    }
  }

  protected unpublish(row = this.selected()): void {
    if (row) {
      this.runAction(row, 'unpublish');
    }
  }

  protected archive(row = this.selected()): void {
    if (row) {
      this.runAction(row, 'archive');
    }
  }

  protected statusClass(status: CmsPageStatus): string {
    return `status-${status}`;
  }

  protected trackByPage(_index: number, page: CmsPage): string {
    return page.pageId;
  }

  protected publicPath(page: CmsPage): string {
    return page.slug === 'home' ? '/' : `/${page.slug}`;
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
      action === 'publish' ? this.api.publishCmsPage(row.pageId) : action === 'unpublish' ? this.api.unpublishCmsPage(row.pageId) : this.api.archiveCmsPage(row.pageId);
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
        canonicalUrl: value.canonicalUrl
      },
      tags: value.tagsCsv
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    };
  }
}
