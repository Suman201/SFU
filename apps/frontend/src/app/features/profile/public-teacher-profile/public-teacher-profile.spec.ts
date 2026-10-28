import { TestBed } from '@angular/core/testing';
import type { Signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject, Subject, of } from 'rxjs';
import type { PublicTeacherProfile as TeacherData } from '@native-sfu/contracts';
import { ProfileService } from '../../../core/services/profile.service';
import { PublicTeacherProfile } from './public-teacher-profile';

interface ProfileState {
  loading: Signal<boolean>;
  teacher: Signal<TeacherData | null>;
  error: Signal<string>;
  activeTab: Signal<string>;
  visibleTabs: Signal<Array<{ id: string }>>;
  loadTeacher(): void;
}

describe('Public teacher profile loading', () => {
  let state: ProfileState;
  let request: Subject<TeacherData>;
  let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let getProfile: jasmine.Spy;

  beforeEach(async () => {
    params = new BehaviorSubject(
      convertToParamMap({ teacherId: 'teacher-one' }),
    );
    request = new Subject<TeacherData>();
    getProfile = jasmine.createSpy().and.returnValue(request);
    await TestBed.configureTestingModule({
      imports: [PublicTeacherProfile],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { paramMap: params, snapshot: { paramMap: params.value } },
        },
        {
          provide: ProfileService,
          useValue: {
            getPublicTeacherProfile: getProfile,
            teachingCatalog: () =>
              of({ categories: [], subjects: [], curricula: [] }),
            errorMessage: () => 'Unable to load profile',
          },
        },
      ],
    })
      .overrideComponent(PublicTeacherProfile, {
        set: { template: '', imports: [] },
      })
      .compileComponents();
    const fixture = TestBed.createComponent(PublicTeacherProfile);
    state = fixture.componentInstance as unknown as ProfileState;
    fixture.detectChanges();
  });

  it('ends the loading state after failure and allows a real retry', () => {
    request.error(new Error('offline'));
    expect(state.loading()).toBeFalse();
    expect(state.error()).toBe('Unable to load profile');
    const retry = new Subject<TeacherData>();
    getProfile.and.returnValue(retry);
    state.loadTeacher();
    expect(state.loading()).toBeTrue();
    retry.complete();
    expect(state.loading()).toBeFalse();
    expect(state.error()).toBe('');
  });

  it('cancels the previous request when the teacher in the URL changes', () => {
    const next = new Subject<TeacherData>();
    getProfile.and.returnValue(next);
    params.next(convertToParamMap({ teacherId: 'teacher-two' }));
    expect(request.observed).toBeFalse();
    expect(getProfile).toHaveBeenCalledWith('teacher-two');
    expect(state.loading()).toBeTrue();
  });

  it('starts with classes and omits empty optional profile sections', () => {
    request.next({
      batches: [],
      credentials: [{ title: 'Teaching certificate' }],
      education: [],
      gallery: [],
      demoClasses: [],
      experience: [],
      socialLinks: [],
    } as unknown as TeacherData);
    request.complete();
    expect(state.activeTab()).toBe('batches');
    expect(state.visibleTabs().map((tab) => tab.id)).toEqual([
      'batches',
      'credentials',
    ]);
  });
});
