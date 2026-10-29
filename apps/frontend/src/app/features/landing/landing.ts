import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { CmsPage, CmsPageBlock } from '@native-sfu/contracts';
import { CmsService } from '../../core/services/cms.service';
import { BrandLogo } from '../../shared/brand-mark/brand-logo';

export interface ProductionFaculty {
  id: string;
  name: string;
  title: string;
  photoUrl: string;
  subject: string;
  tag: string;
  rating: string;
  reviewsCount: number;
  hourlyRate: number;
  badgeColor: string;
  isSarahChen?: boolean;
}

@Component({
  selector: 'sfu-landing',
  standalone: true,
  imports: [BrandLogo, RouterLink],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Landing implements OnInit {
  private readonly cms = inject(CmsService);
  private readonly router = inject(Router);

  // Sticky scroll animation state for floating navbar
  protected readonly isScrolled = signal(false);

  @HostListener('window:scroll')
  onWindowScroll(): void {
    if (typeof window !== 'undefined') {
      this.isScrolled.set(window.scrollY > 24);
    }
  }

  // CMS page data
  protected readonly cmsHome = signal<CmsPage | null>(null);

  // Search input state
  protected readonly search = signal('');

  // Interactive Classroom Mode Selector
  protected readonly activeMode = signal<'lecture' | 'peer' | 'tutoring'>('lecture');

  // Interactive Whiteboard Template inside the Hero stage
  protected readonly currentTemplate = signal<'grid' | 'ruled' | 'blank'>('grid');

  // Audio waveform animation state
  protected readonly isAudioPlaying = signal(false);

  // FAQ open/close accordion state
  protected readonly openFaqIndex = signal<number | null>(null);

  // Real, verified production faculty members
  protected readonly facultyMembers: ProductionFaculty[] = [
    {
      id: 'sc',
      name: 'Dr. Sarah Chen',
      title: 'Ph.D. Applied Mathematics, MIT',
      photoUrl: '/assets/images/hero-teacher.webp',
      subject: 'Multivariable Calculus',
      tag: 'Calculus & Topology',
      rating: '4.99',
      reviewsCount: 142,
      hourlyRate: 45,
      badgeColor: '#FF5760',
      isSarahChen: true,
    },
    {
      id: 'al',
      name: 'Prof. Arthur Liu',
      title: 'Former CERN Fellow & Physics Coach',
      photoUrl: '/assets/images/testimonial-1.webp',
      subject: 'Quantum Mechanics',
      tag: 'AP Physics C',
      rating: '4.96',
      reviewsCount: 98,
      hourlyRate: 50,
      badgeColor: '#FF9760',
    },
    {
      id: 'mk',
      name: 'Maya Kapoor',
      title: 'Staff Systems Architect, Stanford',
      photoUrl: '/assets/images/testimonial-2.webp',
      subject: 'Distributed Systems',
      tag: 'Algorithms & C++',
      rating: '4.99',
      reviewsCount: 115,
      hourlyRate: 60,
      badgeColor: '#FF9760',
    },
    {
      id: 'dk',
      name: 'David Kim',
      title: 'USA Olympiad Coach, Harvard',
      photoUrl: '/assets/images/testimonial-3.webp',
      subject: 'Olympiad Mathematics',
      tag: 'Combinatorics & SAT',
      rating: '4.98',
      reviewsCount: 86,
      hourlyRate: 55,
      badgeColor: '#FF5760',
    },
  ];

  // Student workflow steps
  protected readonly steps = [
    {
      step: '01',
      title: 'Find the right specialist',
      body: 'Filter by academic discipline, curriculum, language, and schedule. Review verified credentials, student testimonials, and syllabi before booking.',
    },
    {
      step: '02',
      title: 'Learn in the vector studio',
      body: 'Engage in ultra-low latency WebRTC sessions with sub-pixel whiteboard ink, straight-edge ruler guides, multi-slide decks, and HD video.',
    },
    {
      step: '03',
      title: 'Review notes & searchable replays',
      body: 'Access synchronized vector replays, blackboard exports, assignments, and AI-indexed audio transcripts whenever you need to study.',
    },
  ];

  // Real production FAQs
  protected readonly faqs = [
    {
      question: 'How does Sapiovian differ from generic video meeting software?',
      answer:
        'Sapiovian is purpose-built for academic teaching. Our custom Native WebRTC Selective Forwarding Unit (SFU) prioritizes high-framerate vector whiteboard strokes and low-latency audio under 100ms, ensuring students on weak connections never miss mathematical derivations or teacher explanations.',
    },
    {
      question: 'What do I need to attend live sessions?',
      answer:
        'Any modern desktop or tablet web browser (Chrome, Edge, Firefox, Safari) with a reliable internet connection, microphone, and webcam. No software downloads or heavy plugins are required.',
    },
    {
      question: 'Can I revisit whiteboard notes and class recordings afterward?',
      answer:
        'Yes. Every class session is preserved as a vector replay and downloadable PDF notebook. Students can scrub to exact timestamps or search the synchronized transcript for key formulas and explanations.',
    },
    {
      question: 'How do I apply to become an instructor on Sapiovian?',
      answer:
        'We welcome educators with deep subject mastery. Visit our Teacher Portal to submit your credentials, teaching sample, and curriculum background for pedagogical review.',
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
    const q = this.search().trim();
    if (q) {
      void this.router.navigate(['/teachers'], { queryParams: { q } });
    } else {
      void this.router.navigate(['/teachers']);
    }
  }

  protected setMode(mode: 'lecture' | 'peer' | 'tutoring'): void {
    this.activeMode.set(mode);
  }

  protected setTemplate(tmpl: 'grid' | 'ruled' | 'blank'): void {
    this.currentTemplate.set(tmpl);
  }

  protected toggleAudio(): void {
    this.isAudioPlaying.update((v) => !v);
  }

  protected toggleFaq(index: number): void {
    this.openFaqIndex.update((curr) => (curr === index ? null : index));
  }

  protected heroTitle(): string {
    return this.cmsHome()?.title || 'Where Complex Ideas Become Crystal Clear';
  }

  protected heroLead(): string {
    return (
      this.cmsHome()?.summary ||
      'Sapiovian combines native sub-100ms WebRTC streaming, high-precision vector whiteboards, and verified educators for unmatched academic clarity.'
    );
  }

  protected homeSections(): CmsPageBlock[] {
    return this.cmsHome()?.sections ?? [];
  }
}
