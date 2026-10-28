import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { TeacherProfile } from './teacher-profile';
import { ProfileService } from '../../../core/services/profile.service';
import { ThemeService } from '../../../core/services/theme.service';
describe('Teacher profile upload recovery', () => {
  let component: any;
  let upload: Subject<any>;
  let preview: Subject<Blob>;
  let api: any;
  beforeEach(async () => {
    upload = new Subject();
    preview = new Subject();
    api = {
      uploadIntroVideo: jasmine.createSpy().and.returnValue(upload),
      previewIntroVideo: jasmine.createSpy().and.returnValue(preview),
      tutorApplication: () => of({ revision: 2, status: 'draft' }),
      errorMessage: () => 'Upload failed. Please try again.',
    };
    await TestBed.configureTestingModule({
      imports: [TeacherProfile],
      providers: [
        { provide: ProfileService, useValue: api },
        { provide: ThemeService, useValue: { setPreference: () => {} } },
      ],
    })
      .overrideComponent(TeacherProfile, { set: { template: '', imports: [] } })
      .compileComponents();
    component = TestBed.createComponent(TeacherProfile).componentInstance;
  });
  it('keeps unsaved profile edits and permits retry after an upload failure', () => {
    component.form.update((f: any) => ({
      ...f,
      displayName: 'Unsaved name',
      introVideoUrl: 'https://youtu.be/abcdefghijk',
    }));
    const event = {
      target: {
        files: [new File(['test'], 'intro.mp4', { type: 'video/mp4' })],
        value: 'intro.mp4',
      },
    } as unknown as Event;
    component.uploadIntroVideo(event);
    expect(component.videoBusy()).toBeTrue();
    upload.error(new Error('Network unavailable'));
    expect(component.videoBusy()).toBeFalse();
    expect(component.form().displayName).toBe('Unsaved name');
    expect(component.form().introVideoUrl).toBe('https://youtu.be/abcdefghijk');
    expect(component.applicationError()).toContain('try again');
    component.uploadIntroVideo(event);
    expect(api.uploadIntroVideo).toHaveBeenCalledTimes(2);
  });
  it('recovers from a failed preview without blocking another attempt', () => {
    component.previewVideo();
    expect(component.videoBusy()).toBeTrue();
    preview.error(new Error('Failed'));
    expect(component.videoBusy()).toBeFalse();
    component.previewVideo();
    expect(api.previewIntroVideo).toHaveBeenCalledTimes(2);
  });
  it('rejects unsupported uploads before sending them', () => {
    component.uploadIntroVideo({
      target: {
        files: [new File(['test'], 'script.html', { type: 'text/html' })],
        value: '',
      },
    } as unknown as Event);
    expect(api.uploadIntroVideo).not.toHaveBeenCalled();
    expect(component.videoBusy()).toBeFalse();
  });
  it('keeps responses for two academic levels in the same category independent', () => {
    const base={categoryId:'math',categoryName:'Mathematics',version:0,type:'knowledge_review',instructions:'Explain a concept.',subjects:[]};
    const primary={...base,levelId:'primary',levelName:'Primary',taskVersion:'primary-v1'};
    const university={...base,levelId:'university',levelName:'University',taskVersion:'university-v1'};
    component.updateAssessment(primary,'response','Primary worked example');
    component.updateAssessment(university,'response','University derivation');
    component.updateAssessment(primary,'evidenceUrl','https://example.com/sample');
    expect(component.form().assessmentResponses.length).toBe(2);
    expect(component.assessmentAnswer(primary)).toBe('Primary worked example');
    expect(component.assessmentAnswer(university)).toBe('University derivation');
    expect(component.assessmentEvidence(university)).toBe('');
  });
  it('retains a stale draft for correction and records the current task version when edited',()=>{
    const task={categoryId:'math',levelId:'primary',taskVersion:'v1'};
    component.updateAssessment(task,'response','Existing draft');
    const updated={...task,taskVersion:'v2'};
    expect(component.assessmentIsStale(updated)).toBeTrue();
    expect(component.assessmentAnswer(updated)).toBe('Existing draft');
    component.updateAssessment(updated,'response','Updated draft');
    expect(component.assessmentIsStale(updated)).toBeFalse();
  });

});
