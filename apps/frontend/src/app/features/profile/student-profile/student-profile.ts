import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';
import { StudentEnrollmentStore } from '../../student/student-enrollment.store';

interface ProfileDetail {
  label: string;
  value: string;
}

@Component({
  selector: 'sfu-student-profile',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './student-profile.html',
  styleUrl: './student-profile.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentProfile {
  protected readonly enrollment = inject(StudentEnrollmentStore);
  protected readonly enrolledCount = computed(() => this.enrollment.enrolledBatches().length);
  protected readonly activeTeachers = computed(
    () => new Set(this.enrollment.enrolledBatches().map((batch) => batch.teacherName)).size
  );

  protected readonly details: ProfileDetail[] = [
    { label: 'Display name', value: 'Student Learner' },
    { label: 'Email', value: 'student@example.com' },
    { label: 'Role', value: 'Student' },
    { label: 'Learning track', value: 'Realtime classroom systems' },
    { label: 'Timezone', value: 'Asia/Kolkata' },
    { label: 'Preferred session window', value: 'Evening batches' }
  ];
}
