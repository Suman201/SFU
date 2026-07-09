import { DatePipe, TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { CmsPage, CmsPageBlock, ContactSubmissionCategory } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { CmsService } from '../../core/services/cms.service';
import { Footer } from '../../shared/footer/footer';
import { Header } from '../../shared/header/header';

interface PublicCmsFallback {
  title: string;
  summary: string;
  body: string;
  pageType: CmsPage['pageType'];
}

const FALLBACKS: Record<string, PublicCmsFallback> = {
  about: {
    title: 'About EDCONNECTION',
    summary: 'A live learning platform connecting teachers and learners across India.',
    body: 'EDCONNECTION helps teachers run live classes, share learning artifacts, and support students through a single education platform.',
    pageType: 'page'
  },
  'contact-us': {
    title: 'Contact Us',
    summary: 'Reach the EDCONNECTION team for support, partnerships, and platform questions.',
    body: 'Email support@edconnection.in or contact your assigned teacher/admin for class-specific help.',
    pageType: 'page'
  },
  faq: {
    title: 'Frequently Asked Questions',
    summary: 'Answers to common teacher and learner questions.',
    body: 'Teachers can host live classes, share recordings and materials, and manage students. Students can join enrolled classes, review recordings, and ask private follow-up questions.',
    pageType: 'faq'
  },
  help: {
    title: 'Help And Support',
    summary: 'Find support for live classes, enrollments, recordings, and account access.',
    body: 'If you are in a live class, use the in-session support tools. For account or enrollment help, contact support with your registered email address.',
    pageType: 'page'
  },
  terms: {
    title: 'Terms And Conditions',
    summary: 'Platform usage terms for teachers, students, and administrators.',
    body: 'This page is a placeholder until the published CMS terms are configured by an administrator.',
    pageType: 'legal'
  },
  'privacy-policy': {
    title: 'Privacy Policy',
    summary: 'How EDCONNECTION handles account, class, and learning data.',
    body: 'This page is a placeholder until the published CMS privacy policy is configured by an administrator.',
    pageType: 'legal'
  },
  'refund-policy': {
    title: 'Refund Policy',
    summary: 'Refund and cancellation guidance for platform purchases.',
    body: 'This page is a placeholder until the published CMS refund policy is configured by an administrator.',
    pageType: 'legal'
  },
  'teacher-marketplace': {
    title: 'Teacher Marketplace',
    summary: 'Discover verified public teacher profiles, demo classes, and open batches.',
    body: 'Browse teachers by topic, language, availability, and published teaching proof before enrolling.',
    pageType: 'landing'
  }
};

@Component({
  selector: 'sfu-public-cms-page',
  standalone: true,
  imports: [DatePipe, Footer, Header, ReactiveFormsModule, RouterLink, TitleCasePipe],
  templateUrl: './public-cms-page.html',
  styleUrl: './public-cms-page.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class PublicCmsPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly cms = inject(CmsService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly page = signal<CmsPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly usingFallback = signal(false);
  protected readonly slug = signal('about');
  protected readonly submittingContact = signal(false);
  protected readonly contactSuccess = signal('');
  protected readonly contactError = signal('');
  protected readonly contactCategories: ContactSubmissionCategory[] = [
    'general',
    'sales',
    'support',
    'partnership',
    'teacher_interest',
    'student_interest',
    'technical_issue'
  ];

  protected readonly contactForm = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(160)]],
    email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]],
    phone: ['', Validators.maxLength(40)],
    category: ['general' as ContactSubmissionCategory],
    subject: ['', [Validators.required, Validators.maxLength(180)]],
    message: ['', [Validators.required, Validators.maxLength(5000)]]
  });

  ngOnInit(): void {
    this.route.data.subscribe((data) => {
      const slug = typeof data['slug'] === 'string' ? data['slug'] : this.route.snapshot.url.at(-1)?.path || 'about';
      this.slug.set(slug);
      this.load(slug);
    });
  }

  protected fallback(): PublicCmsFallback {
    return FALLBACKS[this.slug()] ?? FALLBACKS['about']!;
  }

  protected title(): string {
    return this.page()?.title ?? this.fallback().title;
  }

  protected summary(): string {
    return this.page()?.summary ?? this.fallback().summary;
  }

  protected body(): string {
    return this.page()?.bodyMarkdown ?? this.fallback().body;
  }

  protected pageType(): string {
    return this.page()?.pageType ?? this.fallback().pageType;
  }

  protected sections(): CmsPageBlock[] {
    return this.page()?.sections ?? [];
  }

  protected updatedAt(): string | undefined {
    return this.page()?.publishedAt ?? this.page()?.updatedAt;
  }

  protected isContactPage(): boolean {
    return this.slug() === 'contact-us';
  }

  protected submitContact(): void {
    this.contactError.set('');
    this.contactSuccess.set('');
    if (this.contactForm.invalid) {
      this.contactForm.markAllAsTouched();
      this.contactError.set('Please complete your name, email, subject, and message.');
      return;
    }
    this.submittingContact.set(true);
    const value = this.contactForm.getRawValue();
    this.cms
      .submitContactSubmission({
        name: value.name,
        email: value.email,
        phone: value.phone,
        category: value.category,
        subject: value.subject,
        message: value.message,
        sourcePageSlug: 'contact-us'
      })
      .pipe(finalize(() => this.submittingContact.set(false)))
      .subscribe({
        next: (ack) => {
          this.contactSuccess.set(`Thanks. Your message was received. Reference: ${ack.submissionId.slice(0, 8)}.`);
          this.contactForm.reset({ name: '', email: '', phone: '', category: 'general', subject: '', message: '' });
        },
        error: () => this.contactError.set('We could not send your message right now. Please try again shortly.')
      });
  }

  private load(slug: string): void {
    this.loading.set(true);
    this.usingFallback.set(false);
    this.cms
      .getPublishedPage(slug)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (page) => this.page.set(page),
        error: () => {
          this.page.set(null);
          this.usingFallback.set(true);
        }
      });
  }
}
