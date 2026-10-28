import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';
import {
  EUROPEAN_MARKETS,
  DEFAULT_ASSESSMENT_RUBRIC,
  teachingCategoryPath,
  type TeachingCatalogKind,
  type AcademicAssessmentTask,
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
    { id: 'level' as const, label: 'Academic levels' },
    { id: 'language' as const, label: 'Teaching languages' },
    { id: 'curriculum' as const, label: 'Curricula' },
  ];
  protected readonly title = computed(
    () => this.tabs.find((tab) => tab.id === this.kind())!.label,
  );
  protected readonly rows = signal<TeachingCatalogEntry[]>([]);
  protected readonly levels = signal<TeachingCatalogEntry[]>([]);
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
    assessmentRubric: DEFAULT_ASSESSMENT_RUBRIC,
    assessmentTasks: [] as AcademicAssessmentTask[],
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
      next: (r) => {
        this.categories.set(r.categories);
        this.levels.set(r.levels ?? []);
      },
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
      assessmentRubric: row?.assessmentRubric || DEFAULT_ASSESSMENT_RUBRIC,
      assessmentTasks: (row?.assessmentTasks ?? []).map((t) => ({ ...t })),
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
  protected readonly readiness = signal<any | null>(null);
  protected readonly checkingReadiness = signal(false);
  protected readonly readinessChecks = [
    { key: 'catalogue', label: 'Teaching catalogue' },
    {
      key: 'expertContentApproved',
      label: 'Qualified assessment content approval',
    },
    { key: 'privateVideoStorage', label: 'Private video storage' },
    {
      key: 'encryptedVerificationStorage',
      label: 'Encrypted verification storage',
    },
    { key: 'videoValidator', label: 'Video validation' },
    { key: 'documentValidator', label: 'Document validation' },
    { key: 'smtpTransport', label: 'Email transport' },
  ];
  protected runReadiness() {
    this.checkingReadiness.set(true);
    this.api
      .readiness()
      .pipe(finalize(() => this.checkingReadiness.set(false)))
      .subscribe({
        next: (r) => this.readiness.set(r),
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected readonly contentReview = signal<TeachingCatalogEntry | null>(null);
  protected expertise = '';
  protected contentFindings = '';
  protected qualified = false;
  protected contentApproved(row: TeachingCatalogEntry) {
    return row.assessmentApproval?.version === row.version;
  }
  protected contentLevelLabel(id: string) {
    return (
      this.levels().find((l) => l.id === id)?.name || 'Archived academic level'
    );
  }
  protected openContentReview(row: TeachingCatalogEntry) {
    this.contentReview.set(row);
    this.expertise = '';
    this.contentFindings = '';
    this.qualified = false;
    this.error.set('');
  }
  protected approveContent() {
    const row = this.contentReview();
    if (!row || this.saving()) return;
    this.saving.set(true);
    this.api
      .approveContent(row.kind, row.id, {
        version: row.version,
        expertise: this.expertise,
        notes: this.contentFindings,
        qualifiedReviewerConfirmed: this.qualified,
      })
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.contentReview.set(null);
          this.notice.set('Expert content approval recorded.');
          this.reload();
          this.loadCategories();
        },
        error: (e) => this.error.set(this.api.error(e)),
      });
  }
  protected addTask() {
    const level = this.levels().find(
      (l) => !this.form.assessmentTasks.some((t) => t.levelId === l.id),
    );
    if (level)
      this.form.assessmentTasks.push({
        levelId: level.id,
        type: this.form.assessmentType,
        instructions: '',
      });
  }
  protected removeTask(index: number) {
    this.form.assessmentTasks.splice(index, 1);
  }
  protected taskLevelUsed(id: string, index: number) {
    return this.form.assessmentTasks.some(
      (t, i) => i !== index && t.levelId === id,
    );
  }
  protected save() {
    if (this.saving() || !this.form.name.trim()) return;
    this.saving.set(true);
    this.error.set('');
    const body = {
      ...(['category', 'level'].includes(this.kind())
        ? {
            assessmentType: this.form.assessmentType,
            assessmentInstructions: this.form.assessmentInstructions,
            assessmentRubric: this.form.assessmentRubric,
            ...(this.kind() === 'category'
              ? {
                  assessmentTasks: this.form.assessmentTasks.map((t) => ({
                    ...t,
                    ...(t.rubric?.trim()
                      ? { rubric: t.rubric.trim() }
                      : { rubric: undefined }),
                  })),
                }
              : {}),
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
      ...(['subject', 'category'].includes(this.kind())
        ? { parentId: this.form.parentId }
        : {}),
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
  protected parentChoices() {
    return this.categories().filter(
      (c) =>
        !this.selected ||
        !teachingCategoryPath(this.categories(), c.id).some(
          (p) => p.id === this.selected!.id,
        ),
    );
  }
  protected categoryName(id?: string) {
    if (!id) return 'Top-level category';
    const path = teachingCategoryPath(this.categories(), id);
    if (path.length) return path.map((c) => c.name).join(' › ');
    return (
      this.categories().find((x) => x.id === id)?.name ?? 'Archived category'
    );
  }
}
