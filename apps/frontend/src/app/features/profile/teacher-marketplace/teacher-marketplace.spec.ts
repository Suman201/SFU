import { TestBed } from '@angular/core/testing';
import { type Signal } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, Observable, Subject, of } from 'rxjs';
import type {
  PublicTeacherListItem,
  PublicTeacherListQuery,
  PublicTeacherListResponse,
} from '@native-sfu/contracts';
import { CmsService } from '../../../core/services/cms.service';
import { ProfileService } from '../../../core/services/profile.service';
import { TeacherMarketplace } from './teacher-marketplace';

interface MarketplaceState {
  filters: Signal<Record<string, string>>;
  teachers: Signal<PublicTeacherListItem[]>;
  loading: Signal<boolean>;
  loadingMore: Signal<boolean>;
  error: Signal<string>;
  updateFilter(key: string, value: string): void;
  applyFilters(): void;
  loadMore(): void;
  retry(): void;
}

const response = (page = 1): PublicTeacherListResponse => ({
  teachers: [
    {
      teacherId: `teacher-${page}`,
      displayName: `Teacher ${page}`,
    } as PublicTeacherListItem,
  ],
  page,
  total: 24,
  totalPages: 2,
  limit: 12,
});

describe('Teacher marketplace search', () => {
  const params = new BehaviorSubject(convertToParamMap({ q: 'English' }));
  let requests: Subject<PublicTeacherListResponse>[];
  let list: jasmine.Spy;
  let navigate: jasmine.Spy;
  let state: MarketplaceState;

  beforeEach(async () => {
    params.next(convertToParamMap({ q: 'English' }));
    requests = [];
    list = jasmine
      .createSpy('listPublicTeachers')
      .and.callFake((_query: PublicTeacherListQuery) => {
        const request = new Subject<PublicTeacherListResponse>();
        requests.push(request);
        return request;
      });
    navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    await TestBed.configureTestingModule({
      imports: [TeacherMarketplace],
      providers: [
        { provide: ActivatedRoute, useValue: { queryParamMap: params } },
        { provide: Router, useValue: { navigate } },
        { provide: ProfileService, useValue: { listPublicTeachers: list, teachingCatalog:()=>of({categories:[],subjects:[],curricula:[]}) } },
        { provide: CmsService, useValue: { getPublishedPage: () => of(null) } },
      ],
    })
      .overrideComponent(TeacherMarketplace, {
        set: { template: '', imports: [] },
      })
      .compileComponents();
    const fixture = TestBed.createComponent(TeacherMarketplace);
    state = fixture.componentInstance as unknown as MarketplaceState;
    fixture.detectChanges();
  });

  it('restores URL filters on browser history changes and rejects unsupported availability', () => {
    expect(list.calls.mostRecent().args[0].q).toBe('English');
    params.next(
      convertToParamMap({
        q: 'Math',
        language: 'French',
        availability: 'invalid',
      }),
    );
    expect(state.filters().q).toBe('Math');
    expect(list.calls.mostRecent().args[0]).toEqual(
      jasmine.objectContaining({
        q: 'Math',
        language: 'French',
        availability: undefined,
        page: 1,
      }),
    );
  });

  it('sends catalogue category, subject, level and language filters to the backend',()=>{
    params.next(convertToParamMap({categoryId:'science',subjectId:'physics',levelId:'advanced',languageId:'french'}));
    expect(list.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({categoryId:'science',subjectId:'physics',levelId:'advanced',languageId:'french'}));
  });

  it('clears loading after an API error and allows retry', () => {
    requests[0]!.error(new Error('offline'));
    expect(state.loading()).toBeFalse();
    expect(state.error()).toContain('try again');
    state.retry();
    expect(state.loading()).toBeTrue();
    requests[1]!.next(response());
    requests[1]!.complete();
    expect(state.error()).toBe('');
    expect(state.loading()).toBeFalse();
    expect(state.teachers()[0]!.teacherId).toBe('teacher-1');
  });

  it('cancels the old search so a late result cannot replace the new query', () => {
    const oldRequest = requests[0]!;
    params.next(convertToParamMap({ q: 'Math' }));
    expect(oldRequest.observed).toBeFalse();
    oldRequest.next(response(2));
    expect(state.teachers()).toEqual([]);
    expect(state.loading()).toBeTrue();
    requests[1]!.next(response());
    requests[1]!.complete();
    expect(state.teachers()[0]!.teacherId).toBe('teacher-1');
  });

  it('paginates the applied query even when an unsubmitted filter is being edited', () => {
    requests[0]!.next(response());
    requests[0]!.complete();
    state.updateFilter('q', 'Math');
    state.loadMore();
    expect(list.calls.mostRecent().args[0]).toEqual(
      jasmine.objectContaining({ q: 'English', page: 2 }),
    );
    requests[1]!.next(response(2));
    requests[1]!.complete();
    expect(state.teachers().map((teacher) => teacher.teacherId)).toEqual([
      'teacher-1',
      'teacher-2',
    ]);
    expect(state.loadingMore()).toBeFalse();
  });

  it('releases the load-more state after pagination fails', () => {
    requests[0]!.next(response());
    requests[0]!.complete();
    state.loadMore();
    requests[1]!.error(new Error('offline'));
    expect(state.loadingMore()).toBeFalse();
    state.retry();
    expect(list.calls.mostRecent().args[0].page).toBe(1);
  });

  it('trims submitted filters and removes blank filters from the URL', async () => {
    state.updateFilter('q', '  Spanish  ');
    state.updateFilter('language', '  ');
    state.applyFilters();
    expect(navigate).toHaveBeenCalledOnceWith(['/teachers'], {
      queryParams: { q: 'Spanish' },
    });
  });

  it('unsubscribes an active search when the page is destroyed', () => {
    const cleanup = jasmine.createSpy('request cleanup');
    list.and.returnValue(new Observable(() => cleanup));
    state.retry();
    TestBed.resetTestingModule();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
