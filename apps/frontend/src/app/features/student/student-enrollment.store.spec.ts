import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from '../../core/services/app-environment';
import { StudentEnrollmentStore, type StudentBatch } from './student-enrollment.store';

describe('StudentEnrollmentStore', () => {
  let store: StudentEnrollmentStore;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.setItem('native-sfu-student-enrollments', JSON.stringify({ enrolledBatchIds: ['legacy-demo-batch'] }));
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    store = TestBed.inject(StudentEnrollmentStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('does not expose local demo enrollments before backend data loads', () => {
    expect(store.batches()).toEqual([]);
    expect(store.enrolledBatches()).toEqual([]);
    expect(store.isEnrolled('legacy-demo-batch')).toBeFalse();
  });

  it('loads available and enrolled batches from backend responses', () => {
    const available = batch({ id: 'batch-1', title: 'Backend Batch' });
    const enrolled = batch({ id: 'batch-2', title: 'Backend Enrollment' });

    store.loadAvailableBatches();
    http.expectOne(`${API_BASE_URL}/student-enrollments/batches`).flush({ success: true, data: [available] });

    store.loadEnrolledBatches();
    http.expectOne(`${API_BASE_URL}/student-enrollments/me/batches`).flush({ success: true, data: [enrolled] });

    expect(store.batches().map((item) => item.id)).toEqual(['batch-1']);
    expect(store.enrolledBatches().map((item) => item.id)).toEqual(['batch-2']);
    expect(store.isEnrolled('batch-2')).toBeTrue();
  });

  it('keeps an honest empty state when available batch loading fails', () => {
    store.loadAvailableBatches();

    http.expectOne(`${API_BASE_URL}/student-enrollments/batches`).flush({ message: 'Forbidden' }, { status: 403, statusText: 'Forbidden' });

    expect(store.batches()).toEqual([]);
    expect(store.availableBatchesError()).toContain('Forbidden');
    expect(store.availableBatchesLoaded()).toBeFalse();
  });
});

function batch(overrides: Partial<StudentBatch> = {}): StudentBatch {
  return {
    id: 'batch-1',
    title: 'Backend Batch',
    subject: 'Course',
    teacherId: 'teacher-1',
    teacherName: 'Teacher',
    teacherTitle: 'Class instructor',
    schedule: 'Schedule to be announced',
    durationMinutes: 60,
    totalWeeks: 1,
    enrolledCount: 0,
    capacity: 20,
    startsAt: '2026-06-25T10:00:00.000Z',
    level: 'Intermediate',
    ...overrides
  };
}
