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
    { value: '48ms', label: 'median room join' },
    { value: '12k', label: 'class minutes/week' },
    { value: '99.9%', label: 'session continuity' }
  ];

  protected readonly roomSignals = ['Live SFU', 'Board saved', 'Chat synced', '24 enrolled'];

  protected readonly quickFeatures = [
    { label: 'Adaptive video routing', detail: 'Teacher video, student tiles, and board state stay in one low-latency room.' },
    { label: 'Cohort operations', detail: 'Batch schedules, enrollment signals, and session history live beside the classroom.' },
    { label: 'Learning continuity', detail: 'Whiteboard context, chat, and attendance cues carry from one session to the next.' }
  ];

  protected readonly valueBlocks = [
    {
      eyebrow: 'For teachers',
      title: 'Run the cohort from one calm console.',
      body: 'Open live rooms, track capacity, message batches, and keep every session artifact attached to the right class.',
      route: '/teacher-dashboard',
      cta: 'Teacher dashboard',
      points: ['Session schedule at a glance', 'Batch health and hand raises', 'Whiteboard-first live delivery']
    },
    {
      eyebrow: 'For students',
      title: 'Find the next live batch without friction.',
      body: 'Browse active cohorts, understand seats and timing, and jump into a classroom that keeps chat, video, and board work together.',
      route: '/student/explore',
      cta: 'Explore batches',
      points: ['Clear cohort discovery', 'Upcoming session cues', 'Persistent learning context']
    }
  ];

  protected readonly featuredBatches = [
    {
      title: 'Applied AI Product Lab',
      teacher: 'Meera Shah',
      schedule: 'Tue/Thu - 7:00 PM',
      seats: '18/24 seats',
      status: 'Enrolling',
      tone: 'rose'
    },
    {
      title: 'Realtime Systems Studio',
      teacher: 'Arjun Menon',
      schedule: 'Sat - 10:30 AM',
      seats: '21/28 seats',
      status: 'Live cohort',
      tone: 'green'
    },
    {
      title: 'Design Critique Circle',
      teacher: 'Nisha Rao',
      schedule: 'Mon/Wed - 6:30 PM',
      seats: '12/16 seats',
      status: 'Starts soon',
      tone: 'amber'
    }
  ];

  protected readonly platformStats = [
    { value: '6', label: 'active teaching surfaces' },
    { value: '4', label: 'cohort workflows' },
    { value: '1', label: 'native SFU room core' },
    { value: '0', label: 'external class links required' }
  ];
}
