import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Footer } from '../../shared/footer/footer';
import { Header } from '../../shared/header/header';

@Component({
  selector: 'sfu-landing',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class Landing {
  protected readonly heroStats = [
    { value: '1:1', label: 'teacher-student connection' },
    { value: '24/7', label: 'classes across time zones' },
    { value: 'Any', label: 'subject, skill, or language' }
  ];

  protected readonly roomSignals = ['Live class', 'Board saved', 'Chat synced', '18 enrolled'];

  protected readonly quickFeatures = [
    { label: 'Teacher storefronts', detail: 'Educators can publish subjects, batches, availability, pricing, and class formats from one profile.' },
    { label: 'Student discovery', detail: 'Learners compare teachers, timings, seats, and upcoming sessions before joining a class.' },
    { label: 'Live learning tools', detail: 'Video, chat, whiteboard, attendance, and session context stay attached to every class.' }
  ];

  protected readonly valueBlocks = [
    {
      eyebrow: 'For teachers',
      title: 'Turn what you know into a live class.',
      body: 'Create public batches, manage students, run sessions, and grow a teaching presence without needing a separate operations stack.',
      route: '/teacher/dashboard',
      cta: 'Teacher dashboard',
      points: ['Create classes for any subject', 'Manage enrollments and schedules', 'Teach with video, chat, and whiteboard']
    },
    {
      eyebrow: 'For students',
      title: 'Find the right teacher for your goal.',
      body: 'Explore teachers across subjects, compare live batches, and join classes that match your schedule and learning style.',
      route: '/student/explore',
      cta: 'Explore classes',
      points: ['Browse teachers by skill', 'Review timing and available seats', 'Keep class history in one place']
    }
  ];

  protected readonly featuredBatches = [
    {
      title: 'Spoken English Confidence',
      teacher: 'Meera Shah',
      schedule: 'Tue/Thu - 7:00 PM',
      seats: '18/24 seats',
      status: 'Enrolling',
      tone: 'rose'
    },
    {
      title: 'Maths for Competitive Exams',
      teacher: 'Arjun Menon',
      schedule: 'Sat - 10:30 AM',
      seats: '21/28 seats',
      status: 'Live class',
      tone: 'green'
    },
    {
      title: 'Beginner Guitar Weekend',
      teacher: 'Nisha Rao',
      schedule: 'Mon/Wed - 6:30 PM',
      seats: '12/16 seats',
      status: 'Starts soon',
      tone: 'amber'
    }
  ];

  protected readonly platformStats = [
    { value: '2', label: 'clear journeys: teach and learn' },
    { value: 'Any', label: 'teacher can publish a class' },
    { value: 'Any', label: 'student can discover a teacher' },
    { value: '0', label: 'external class links required' }
  ];
}
