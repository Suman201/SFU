import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { CmsPage, CmsPageBlock } from '@native-sfu/contracts';
import { CmsService } from '../../core/services/cms.service';
import { Footer } from '../../shared/footer/footer';
import { Header } from '../../shared/header/header';

@Component({
  selector: 'sfu-landing',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Landing implements OnInit {
  private readonly cms = inject(CmsService);
  private readonly router = inject(Router);
  protected readonly cmsHome = signal<CmsPage | null>(null);
  protected readonly search = signal('');
  protected readonly steps = [
    {
      title: 'Choose a teacher',
      body: 'Search by subject or language. Read profiles and check the classes each teacher offers.',
    },
    {
      title: 'Join a class',
      body: 'Enroll in an available class, then join it from your dashboard when it starts.',
    },
    {
      title: 'Keep learning',
      body: 'Find assignments, shared materials and published recordings alongside your classes.',
    },
  ];
  protected readonly faqs = [
    {
      question: 'How do I find the right teacher?',
      answer:
        'Start with a subject or skill, then filter by language and availability. Each public teacher profile shows their teaching background and available classes so you can decide what fits.',
    },
    {
      question: 'What do I need to join a class?',
      answer:
        'A reliable internet connection and a computer with a supported browser, microphone and speakers. Check your camera and audio in device settings before joining.',
    },
    {
      question: 'Can I revisit a lesson afterward?',
      answer:
        'When your teacher records and publishes a class, you can revisit it along with the materials they share. Recording availability depends on the class and your access.',
    },
    {
      question: 'How can I teach on Sapiovian?',
      answer:
        'Contact our team to learn about teacher access. If you already have a teacher account, sign in to set up your profile, manage classes and start teaching.',
    },
  ];
  ngOnInit(): void {
    this.cms.getPublishedPage('home', 'en', true).subscribe({
      next: (page) => this.cmsHome.set(page),
      error: () => this.cmsHome.set(null),
    });
  }
  protected updateSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }
  protected findTeacher(event: Event): void {
    event.preventDefault();
    void this.router.navigate(['/teachers'], {
      queryParams: { q: this.search().trim() || null },
    });
  }
  protected heroTitle(): string {
    return (
      this.cmsHome()?.title || 'Find the right teacher. Learn from anywhere.'
    );
  }
  protected heroLead(): string {
    return (
      this.cmsHome()?.summary ||
      'Explore teachers and join live online classes. Learn with a shared whiteboard, and return to your class materials whenever you need them.'
    );
  }
  protected homeSections(): CmsPageBlock[] {
    return this.cmsHome()?.sections ?? [];
  }
}
