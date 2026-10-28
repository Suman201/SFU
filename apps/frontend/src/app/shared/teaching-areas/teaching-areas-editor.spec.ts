import { TestBed } from '@angular/core/testing';
import { TeachingAreasEditor } from './teaching-areas-editor';
import {
  type TeachingCatalogSnapshot,
  type TeacherTeachingArea,
} from '@native-sfu/contracts';
describe('Teaching areas editor', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<TeachingAreasEditor>>;
  let component: any;
  const entry = (id: string, parentId?: string) => ({
    id,
    name: id,
    ...(parentId ? { parentId } : {}),
    aliases: [],
    status: 'active' as const,
    version: 0,
    sortOrder: 0,
    description: '',
    countryCodes: [],
  });
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TeachingAreasEditor],
    }).compileComponents();
    fixture = TestBed.createComponent(TeachingAreasEditor);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('catalog', {
      categories: Array.from({ length: 20 }, (_, i) => ({
        ...entry('cat' + i),
        kind: 'category',
      })),
      subjects: Array.from({ length: 50 }, (_, i) => ({
        ...entry('subject' + i, 'cat0'),
        kind: 'subject',
      })),
      curricula: [],
      levels: [
        { ...entry('primary'), kind: 'level' },
        { ...entry('undergraduate'), kind: 'level' },
      ],
      languages: [
        { ...entry('english'), kind: 'language' },
        { ...entry('french'), kind: 'language' },
      ],
    } satisfies TeachingCatalogSnapshot);
    fixture.componentRef.setInput('areas', []);
    fixture.componentInstance.areasChange.subscribe((areas) =>
      fixture.componentRef.setInput('areas', areas),
    );
    fixture.detectChanges();
  });
  it('adds more than eight categories and subjects without losing selections', () => {
    for (let i = 0; i < 20; i++) {
      component.categoryChoice.set('cat' + i);
      component.add();
    }
    for (let i = 0; i < 50; i++)
      component.toggle(0, 'subjectIds', 'subject' + i);
    expect(component.areas().length).toBe(20);
    expect(component.areas()[0].subjectIds.length).toBe(50);
    component.toggle(0, 'subjectIds', 'subject10');
    expect(component.areas()[0].subjectIds).not.toContain('subject10');
  });
  it('keeps academic level and languages specific to their teaching area', () => {
    for (const category of ['cat0', 'cat1']) {
      component.categoryChoice.set(category);
      component.add();
    }
    component.toggle(0, 'levelIds', 'undergraduate');
    component.toggle(0, 'languageIds', 'french');
    component.toggle(1, 'levelIds', 'primary');
    component.toggle(1, 'languageIds', 'english');
    expect(component.areas()[0].levelIds).toEqual(['undergraduate']);
    expect(component.areas()[0].languageIds).toEqual(['french']);
    expect(component.areas()[1].levelIds).toEqual(['primary']);
    expect(component.areas()[1].languageIds).toEqual(['english']);
  });
  it('supports Other without inventing a catalogue subject or category', () => {
    component.categoryChoice.set('other');
    component.add();
    component.setOtherSubjects(0, {
      target: { value: 'Specialist coaching\nNew discipline' },
    });
    const other = component.areas()[0] as TeacherTeachingArea;
    expect(other.categoryId).toBeUndefined();
    expect(other.subjectIds).toEqual([]);
    expect(other.otherSubjects.length).toBe(2);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('no preset assessment');
    component.remove(0);
    expect(component.areas()).toEqual([]);
  });
});
