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
});
