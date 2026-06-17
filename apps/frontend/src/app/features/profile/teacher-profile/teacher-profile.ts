import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

interface ProfileMetric {
  label: string;
  value: string;
}

interface ProfileDetail {
  label: string;
  value: string;
}

@Component({
  selector: 'sfu-teacher-profile',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './teacher-profile.html',
  styleUrl: './teacher-profile.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherProfile {
  protected readonly metrics: ProfileMetric[] = [
    { label: 'Hosted batches', value: '4' },
    { label: 'Weekly sessions', value: '12' },
    { label: 'Students', value: '86' }
  ];

  protected readonly details: ProfileDetail[] = [
    { label: 'Display name', value: 'Teacher Host' },
    { label: 'Email', value: 'teacher@example.com' },
    { label: 'Role', value: 'Teacher' },
    { label: 'Specialization', value: 'Realtime WebRTC classrooms' },
    { label: 'Timezone', value: 'Asia/Kolkata' },
    { label: 'Office hours', value: 'Tuesday and Thursday, 18:00' }
  ];
}
