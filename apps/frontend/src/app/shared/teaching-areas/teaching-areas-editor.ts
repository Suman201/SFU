import {
  Component,
  computed,
  input,
  output,
  signal,
  afterNextRender,
  inject,
  Injector,
  ElementRef,
  viewChildren,
} from '@angular/core';
import {
  teachingCategoryIds,
  teachingCategoryPath,
  type TeacherTeachingArea,
  type TeachingCatalogEntry,
  type TeachingCatalogSnapshot,
} from '@native-sfu/contracts';
@Component({
  selector: 'sfu-teaching-areas-editor',
  standalone: true,
  templateUrl: './teaching-areas-editor.html',
  styleUrl: './teaching-areas-editor.scss',
})
export class TeachingAreasEditor {
  private readonly injector = inject(Injector);
  private readonly cards =
    viewChildren<ElementRef<HTMLDetailsElement>>('areaCard');
  readonly catalog = input.required<TeachingCatalogSnapshot>();
  readonly areas = input.required<TeacherTeachingArea[]>();
  readonly areasChange = output<TeacherTeachingArea[]>();
  protected readonly categorySearch = signal('');
  protected readonly categoryChoice = signal('');
  protected readonly expanded = signal('');
  protected readonly subjectSearch = signal<Record<string, string>>({});
  protected readonly languageSearch = signal<Record<string, string>>({});
  protected readonly choices = computed(() => {
    const q = this.categorySearch().trim().toLowerCase();
    return this.catalog()
      .categories.filter(
        (c) =>
          !this.areas().some((a) => a.categoryId === c.id) &&
          (!q || this.categoryName(c.id).toLowerCase().includes(q)),
      )
      .sort((a, b) =>
        this.categoryName(a.id).localeCompare(this.categoryName(b.id)),
      );
  });
  protected key(area: TeacherTeachingArea) {
    return area.categoryId ?? 'other';
  }
  protected categoryName(id?: string) {
    if (!id) return 'Other / subject not listed';
    return (
      teachingCategoryPath(this.catalog().categories, id)
        .map((c) => c.name)
        .join(' › ') || 'Archived category'
    );
  }
  protected text(event: Event) {
    return (event.target as HTMLInputElement).value;
  }
  protected add() {
    const id = this.categoryChoice();
    if (!id || this.areas().some((a) => this.key(a) === id)) return;
    this.areasChange.emit([
      ...this.areas(),
      {
        ...(id === 'other' ? {} : { categoryId: id }),
        subjectIds: [],
        otherSubjects: [],
        levelIds: [],
        languageIds: [],
      },
    ]);
    this.expanded.set(id);
    this.categoryChoice.set('');
    this.categorySearch.set('');
    afterNextRender(
      () => {
        const card = this.cards().at(-1)?.nativeElement;
        card?.querySelector('summary')?.focus({ preventScroll: true });
        card?.scrollIntoView({ block: 'start', behavior: 'auto' });
      },
      { injector: this.injector },
    );
  }
  protected isExpanded(area: TeacherTeachingArea, index: number) {
    return (
      this.expanded() === this.key(area) ||
      (this.expanded() === '' && index === 0)
    );
  }
  protected toggleExpanded(
    event: Event,
    area: TeacherTeachingArea,
    index: number,
  ) {
    event.preventDefault();
    this.expanded.set(this.isExpanded(area, index) ? 'closed' : this.key(area));
  }
  protected remove(index: number) {
    this.areasChange.emit(this.areas().filter((_, i) => i !== index));
  }
  protected update(index: number, patch: Partial<TeacherTeachingArea>) {
    this.areasChange.emit(
      this.areas().map((area, i) =>
        i === index ? { ...area, ...patch } : area,
      ),
    );
  }
  protected toggle(
    index: number,
    field: 'subjectIds' | 'levelIds' | 'languageIds',
    id: string,
  ) {
    const values = this.areas()[index]![field];
    this.update(index, {
      [field]: values.includes(id)
        ? values.filter((x) => x !== id)
        : [...values, id],
    });
  }
  protected setOtherSubjects(index: number, event: Event) {
    this.update(index, { otherSubjects: this.text(event).split('\n') });
  }
  protected search(
    area: TeacherTeachingArea,
    field: 'subjects' | 'languages',
    event: Event,
  ) {
    const target =
      field === 'subjects' ? this.subjectSearch : this.languageSearch;
    target.update((v) => ({ ...v, [this.key(area)]: this.text(event) }));
  }
  protected subjects(area: TeacherTeachingArea) {
    const ids = teachingCategoryIds(
      this.catalog().categories,
      area.categoryId!,
    );
    const q = (this.subjectSearch()[this.key(area)] ?? '').toLowerCase().trim();
    return this.catalog().subjects.filter(
      (s) =>
        ids.includes(s.parentId!) &&
        (!q || [s.name, ...s.aliases].some((n) => n.toLowerCase().includes(q))),
    );
  }
  protected languages(area: TeacherTeachingArea) {
    const q = (this.languageSearch()[this.key(area)] ?? '')
      .toLowerCase()
      .trim();
    return (this.catalog().languages ?? []).filter(
      (l) =>
        !q || [l.name, ...l.aliases].some((n) => n.toLowerCase().includes(q)),
    );
  }
  protected selectedNames(ids: string[], entries: TeachingCatalogEntry[] = []) {
    return ids
      .map(
        (id) => entries.find((e) => e.id === id)?.name ?? 'Archived selection',
      )
      .join(', ');
  }
  protected retired(
    area: TeacherTeachingArea,
    field: 'subjectIds' | 'levelIds' | 'languageIds',
  ) {
    const entries =
      field === 'subjectIds'
        ? this.catalog().subjects
        : field === 'levelIds'
          ? (this.catalog().levels ?? [])
          : (this.catalog().languages ?? []);
    const categoryIds = area.categoryId
      ? teachingCategoryIds(this.catalog().categories, area.categoryId)
      : [];
    return area[field].filter(
      (id) =>
        !entries.some(
          (e) =>
            e.id === id &&
            (field !== 'subjectIds' || categoryIds.includes(e.parentId!)),
        ),
    );
  }
  protected readonly hasOther = computed(() =>
    this.areas().some((a) => !a.categoryId),
  );
}
