import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import { ProfileService } from '../../../core/services/profile.service';
import { Footer } from '../../../shared/footer/footer';
import { Header } from '../../../shared/header/header';
import { TeacherDashboardStore } from '../teacher-dashboard.store';
import {
  EMPTY_LIVE_SETTINGS_FORM,
  LIVE_SETTINGS_SECTIONS,
  type LiveSettingsField,
  type LiveSettingsForm,
  type LiveSettingsFormKey,
  type LiveSettingsFormValue,
  liveSettingsFormFromSettings,
  liveSettingsOverrideKeysFromPatch,
  liveSettingsPatchFromForm
} from './live-settings.model';

@Component({
  selector: 'sfu-teacher-live-settings',
  standalone: true,
  imports: [Footer, Header, RouterLink],
  templateUrl: './teacher-live-settings.html',
  styleUrl: './teacher-live-settings.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherLiveSettings implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly profiles = inject(ProfileService);
  protected readonly dashboard = inject(TeacherDashboardStore);

  private readonly paramMap = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
  protected readonly sections = LIVE_SETTINGS_SECTIONS;
  protected readonly batchId = computed(() => this.paramMap().get('batchId') ?? '');
  protected readonly isBatchMode = computed(() => Boolean(this.batchId()));
  protected readonly batch = computed(() => this.dashboard.batches().find((item) => item.id === this.batchId()) ?? null);
  protected readonly batchTitle = computed(() => this.batch()?.name ?? (this.batchId() ? `Batch ${this.batchId()}` : 'Global defaults'));
  protected readonly pageTitle = computed(() => (this.isBatchMode() ? 'Batch live settings' : 'Live settings'));
  protected readonly pageDescription = computed(() =>
    this.isBatchMode()
      ? 'Override teacher defaults only where this batch needs different live-class behavior.'
      : 'Set global teacher defaults for future live classes. Batch overrides can still customize specific fields.'
  );
  protected readonly backLink = computed(() => (this.isBatchMode() ? ['/teacher/dashboard/batches', this.batchId()] : ['/teacher/dashboard']));
  protected readonly totalFields = LIVE_SETTINGS_SECTIONS.reduce((total, section) => total + section.fields.length, 0);
  protected readonly form = signal<LiveSettingsForm>({ ...EMPTY_LIVE_SETTINGS_FORM });
  protected readonly inheritedForm = signal<LiveSettingsForm | null>(null);
  protected readonly overriddenKeys = signal<Set<LiveSettingsFormKey>>(new Set());
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly resetting = signal(false);
  protected readonly notice = signal('');
  protected readonly error = signal('');

  ngOnInit(): void {
    if (this.isBatchMode()) {
      this.dashboard.loadBatches();
    }
    this.loadSettings();
  }

  protected loadSettings(): void {
    this.loading.set(true);
    this.notice.set('');
    this.error.set('');

    if (this.isBatchMode()) {
      this.dashboard
        .getBatchLiveSettings(this.batchId())
        .pipe(finalize(() => this.loading.set(false)))
        .subscribe({
          next: (response) => {
            this.inheritedForm.set(liveSettingsFormFromSettings(response.teacherDefaults));
            this.form.set(liveSettingsFormFromSettings(response.resolved));
            this.overriddenKeys.set(liveSettingsOverrideKeysFromPatch(response.overrides));
          },
          error: (error) => this.error.set(this.profiles.errorMessage(error))
        });
      return;
    }

    this.profiles
      .getTeacherLiveSettings()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (response) => {
          this.inheritedForm.set(null);
          this.form.set(liveSettingsFormFromSettings(response.settings));
          this.overriddenKeys.set(new Set());
        },
        error: (error) => this.error.set(this.profiles.errorMessage(error))
      });
  }

  protected saveSettings(): void {
    if (this.saving()) {
      return;
    }

    this.saving.set(true);
    this.notice.set('');
    this.error.set('');

    if (this.isBatchMode()) {
      this.dashboard
        .updateBatchLiveSettings(this.batchId(), liveSettingsPatchFromForm(this.form(), this.overriddenKeys()))
        .pipe(finalize(() => this.saving.set(false)))
        .subscribe({
          next: (response) => {
            this.inheritedForm.set(liveSettingsFormFromSettings(response.teacherDefaults));
            this.form.set(liveSettingsFormFromSettings(response.resolved));
            this.overriddenKeys.set(liveSettingsOverrideKeysFromPatch(response.overrides));
            this.notice.set('Batch live settings saved.');
          },
          error: (error) => this.error.set(this.profiles.errorMessage(error))
        });
      return;
    }

    this.profiles
      .updateTeacherLiveSettings(liveSettingsPatchFromForm(this.form()))
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (response) => {
          this.form.set(liveSettingsFormFromSettings(response.settings));
          this.notice.set('Global live settings saved.');
        },
        error: (error) => this.error.set(this.profiles.errorMessage(error))
      });
  }

  protected resetAllOverrides(): void {
    if (!this.isBatchMode() || this.resetting()) {
      return;
    }

    this.resetting.set(true);
    this.notice.set('');
    this.error.set('');

    this.dashboard
      .resetBatchLiveSettings(this.batchId())
      .pipe(finalize(() => this.resetting.set(false)))
      .subscribe({
        next: (response) => {
          this.inheritedForm.set(liveSettingsFormFromSettings(response.teacherDefaults));
          this.form.set(liveSettingsFormFromSettings(response.resolved));
          this.overriddenKeys.set(liveSettingsOverrideKeysFromPatch(response.overrides));
          this.notice.set('Batch overrides reset to global defaults.');
        },
        error: (error) => this.error.set(this.profiles.errorMessage(error))
      });
  }

  protected toggleOverride(field: LiveSettingsField, enabled: boolean): void {
    if (!this.isBatchMode()) {
      return;
    }

    this.overriddenKeys.update((current) => {
      const next = new Set(current);
      if (enabled) {
        next.add(field.key);
      } else {
        next.delete(field.key);
        const inherited = this.inheritedForm();
        if (inherited) {
          this.form.update((form) => ({ ...form, [field.key]: inherited[field.key] }));
        }
      }
      return next;
    });
  }

  protected isOverridden(key: LiveSettingsFormKey): boolean {
    return this.overriddenKeys().has(key);
  }

  protected inheritanceLabel(field: LiveSettingsField): string {
    if (!this.isBatchMode()) {
      return 'Global';
    }
    return this.isOverridden(field.key) ? 'Overridden' : 'Using global';
  }

  protected fieldDisabled(field: LiveSettingsField): boolean {
    return this.loading() || this.saving() || this.resetting() || (this.isBatchMode() && !this.isOverridden(field.key));
  }

  protected updateBooleanField(field: LiveSettingsField, event: Event): void {
    this.updateField(field, this.checkedValue(event));
  }

  protected updateTextField(field: LiveSettingsField, event: Event): void {
    this.updateField(field, this.inputValue(event));
  }

  protected updateSelectField(field: LiveSettingsField, event: Event): void {
    this.updateField(field, this.inputValue(event));
  }

  protected updateNumberField(field: LiveSettingsField, event: Event): void {
    const fallback = this.numberFieldValue(field);
    const value = this.numberValue(event, fallback);
    this.updateField(field, this.clampNumber(value, field));
  }

  protected booleanFieldValue(field: LiveSettingsField): boolean {
    return Boolean(this.form()[field.key]);
  }

  protected numberFieldValue(field: LiveSettingsField): number {
    const value = this.form()[field.key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  protected stringFieldValue(field: LiveSettingsField): string {
    const value = this.form()[field.key];
    return typeof value === 'string' ? value : String(value);
  }

  protected checkedValue(event: Event): boolean {
    return event.target instanceof HTMLInputElement ? event.target.checked : false;
  }

  private updateField(field: LiveSettingsField, value: LiveSettingsFormValue): void {
    if (this.isBatchMode() && !this.isOverridden(field.key)) {
      return;
    }
    this.form.update((form) => ({ ...form, [field.key]: value }));
  }

  private inputValue(event: Event): string {
    return event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ? event.target.value : '';
  }

  private numberValue(event: Event, fallback: number): number {
    const rawValue = this.inputValue(event);
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : fallback;
  }

  private clampNumber(value: number, field: LiveSettingsField): number {
    const min = field.min ?? Number.NEGATIVE_INFINITY;
    const max = field.max ?? Number.POSITIVE_INFINITY;
    return Math.min(max, Math.max(min, value));
  }
}
