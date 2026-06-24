import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ProfileSettings, ProfileThemePreference, ProfileUser, UpdateMyProfileRequest, UpdateMySettingsRequest } from '@native-sfu/contracts';
import { ProfileService } from '../../../core/services/profile.service';
import { ThemeService } from '../../../core/services/theme.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';

interface StudentProfileForm {
  displayName: string;
  phone: string;
  location: string;
  timezone: string;
  languagesText: string;
  learningGoalsText: string;
  interestsText: string;
}

interface ProfileSettingsForm {
  theme: ProfileThemePreference;
  locale: string;
  notificationEmail: boolean;
  notificationClassReminders: boolean;
  notificationChatMessages: boolean;
  notificationAnnouncements: boolean;
  notificationRecordingReady: boolean;
  privacyAllowTeacherMessages: boolean;
}

const EMPTY_FORM: StudentProfileForm = {
  displayName: '',
  phone: '',
  location: '',
  timezone: '',
  languagesText: '',
  learningGoalsText: '',
  interestsText: ''
};

const EMPTY_SETTINGS_FORM: ProfileSettingsForm = {
  theme: 'system',
  locale: 'en-US',
  notificationEmail: true,
  notificationClassReminders: true,
  notificationChatMessages: true,
  notificationAnnouncements: true,
  notificationRecordingReady: true,
  privacyAllowTeacherMessages: true
};

@Component({
  selector: 'sfu-student-profile',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './student-profile.html',
  styleUrl: './student-profile.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentProfile implements OnInit {
  private readonly profiles = inject(ProfileService);
  private readonly theme = inject(ThemeService);

  protected readonly profile = signal<ProfileUser | null>(null);
  protected readonly form = signal<StudentProfileForm>({ ...EMPTY_FORM });
  protected readonly settingsForm = signal<ProfileSettingsForm>({ ...EMPTY_SETTINGS_FORM });
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly savingSettings = signal(false);
  protected readonly uploadingAvatar = signal(false);
  protected readonly editing = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly enrolledCount = computed(() => this.profile()?.batches.length ?? 0);
  protected readonly activeTeachers = computed(() => new Set((this.profile()?.batches ?? []).map((batch) => batch.teacherName || batch.teacherId)).size);

  ngOnInit(): void {
    this.loadProfile();
  }

  protected loadProfile(): void {
    this.loading.set(true);
    this.error.set('');
    this.profiles.getMyProfile().subscribe({
      next: (profile) => {
        this.profile.set(profile);
        this.form.set(this.formFromProfile(profile));
        this.settingsForm.set(this.settingsFormFromProfile(profile.settings));
        this.theme.setPreference(profile.settings.theme);
      },
      error: (error) => this.error.set(this.profiles.errorMessage(error)),
      complete: () => this.loading.set(false)
    });
  }

  protected saveProfile(): void {
    if (this.saving()) {
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.notice.set('');
    this.profiles.updateMyProfile(this.updateRequest()).subscribe({
      next: (profile) => {
        this.profile.set(profile);
        this.form.set(this.formFromProfile(profile));
        this.editing.set(false);
        this.notice.set('Profile updated.');
      },
      error: (error) => this.error.set(this.profiles.errorMessage(error)),
      complete: () => this.saving.set(false)
    });
  }

  protected saveSettings(): void {
    if (this.savingSettings()) {
      return;
    }
    this.savingSettings.set(true);
    this.error.set('');
    this.notice.set('');
    this.profiles.updateMySettings(this.settingsRequest()).subscribe({
      next: (settings) => {
        this.profile.update((profile) => (profile ? { ...profile, settings } : profile));
        this.settingsForm.set(this.settingsFormFromProfile(settings));
        this.theme.setPreference(settings.theme);
        this.notice.set('Settings updated.');
      },
      error: (error) => this.error.set(this.profiles.errorMessage(error)),
      complete: () => this.savingSettings.set(false)
    });
  }

  protected uploadAvatar(event: Event): void {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const file = input?.files?.[0];
    if (!file) {
      return;
    }
    this.uploadingAvatar.set(true);
    this.error.set('');
    this.notice.set('');
    this.profiles.uploadProfileAvatar(file).subscribe({
      next: (response) => {
        this.profile.update((profile) => (profile ? { ...profile, avatarUrl: response.url } : profile));
        this.notice.set('Avatar updated.');
      },
      error: (error) => this.error.set(this.profiles.errorMessage(error)),
      complete: () => {
        this.uploadingAvatar.set(false);
        if (input) {
          input.value = '';
        }
      }
    });
  }

  protected updateForm<K extends keyof StudentProfileForm>(key: K, value: StudentProfileForm[K]): void {
    this.form.update((form) => ({ ...form, [key]: value }));
  }

  protected updateSettingsForm<K extends keyof ProfileSettingsForm>(key: K, value: ProfileSettingsForm[K]): void {
    this.settingsForm.update((form) => ({ ...form, [key]: value }));
  }

  protected inputValue(event: Event): string {
    return event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ? event.target.value : '';
  }

  protected selectValue(event: Event): string {
    return event.target instanceof HTMLSelectElement ? event.target.value : '';
  }

  protected themeValue(event: Event): ProfileThemePreference {
    const value = this.selectValue(event);
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  }

  protected checkedValue(event: Event): boolean {
    return event.target instanceof HTMLInputElement ? event.target.checked : false;
  }

  protected profileImage(): string {
    const profile = this.profile();
    if (profile?.avatarUrl) {
      return this.profiles.resolveMediaUrl(profile.avatarUrl);
    }
    return this.initials(profile?.displayName ?? 'Student');
  }

  protected initials(name: string): string {
    return name
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  protected formatStart(value: string | undefined): string {
    if (!value) {
      return 'No start date';
    }
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    }).format(new Date(value));
  }

  private updateRequest(): UpdateMyProfileRequest {
    const form = this.form();
    return {
      displayName: form.displayName,
      phone: form.phone,
      location: form.location,
      timezone: form.timezone,
      languages: this.parseList(form.languagesText),
      learningGoals: this.parseList(form.learningGoalsText),
      interests: this.parseList(form.interestsText)
    };
  }

  private settingsRequest(): UpdateMySettingsRequest {
    const form = this.settingsForm();
    return {
      theme: form.theme,
      locale: form.locale,
      notifications: {
        email: form.notificationEmail,
        classReminders: form.notificationClassReminders,
        chatMessages: form.notificationChatMessages,
        announcements: form.notificationAnnouncements,
        recordingReady: form.notificationRecordingReady
      },
      privacy: {
        allowTeacherMessages: form.privacyAllowTeacherMessages
      }
    };
  }

  private formFromProfile(profile: ProfileUser): StudentProfileForm {
    return {
      displayName: profile.displayName,
      phone: profile.phone ?? '',
      location: profile.location ?? '',
      timezone: profile.timezone ?? '',
      languagesText: profile.languages.join(', '),
      learningGoalsText: profile.learningGoals.join('\n'),
      interestsText: profile.interests.join(', ')
    };
  }

  private settingsFormFromProfile(settings: ProfileSettings): ProfileSettingsForm {
    return {
      theme: settings.theme,
      locale: settings.locale,
      notificationEmail: settings.notifications.email,
      notificationClassReminders: settings.notifications.classReminders,
      notificationChatMessages: settings.notifications.chatMessages,
      notificationAnnouncements: settings.notifications.announcements,
      notificationRecordingReady: settings.notifications.recordingReady,
      privacyAllowTeacherMessages: settings.privacy.allowTeacherMessages
    };
  }

  private parseList(value: string): string[] {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}
