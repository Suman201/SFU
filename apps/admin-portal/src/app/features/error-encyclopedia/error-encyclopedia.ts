import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';
import { toSignal } from '@angular/core/rxjs-interop';
import { ThemeService } from '../../core/services/theme.service';
import { ALL_ERROR_GUIDES, ERROR_AREAS, findErrorGuide } from './error-guides';

@Component({
  selector: 'sfu-error-encyclopedia',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './error-encyclopedia.html',
  styleUrl: './error-encyclopedia.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ErrorEncyclopedia {
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });
  readonly theme = inject(ThemeService);
  readonly query = signal(
    (this.route.snapshot.queryParamMap.get('q') ?? '').slice(0, 160),
  );
  readonly area = signal(
    ERROR_AREAS.find(
      (value) => value === this.route.snapshot.queryParamMap.get('category'),
    ) ?? 'All errors',
  );
  readonly areas = ERROR_AREAS;
  readonly guides = ALL_ERROR_GUIDES;
  readonly copied = signal(false);
  readonly copyFailed = signal(false);
  readonly requested = computed(() => this.params().get('code'));
  readonly guide = computed(() => findErrorGuide(this.requested()));
  readonly results = computed(() => {
    const words = this.query()
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return this.guides.filter(
      (guide) =>
        (this.area() === 'All errors' || guide.area === this.area()) &&
        words.every((word) =>
          `${guide.code} ${guide.reason} ${guide.name} ${guide.message} ${guide.explanation} ${guide.causes.join(' ')} ${guide.developerChecks.join(' ')}`
            .toLowerCase()
            .includes(word),
        ),
    );
  });
  readonly groups = computed(() =>
    this.areas
      .map((area) => ({
        area,
        items: this.results().filter((guide) => guide.area === area),
      }))
      .filter((group) => group.items.length),
  );
  readonly permalink = computed(() =>
    this.guide()
      ? `${location.origin}/error-encyclopedia/${this.guide()!.code}`
      : '',
  );
  readonly related = computed(
    () => this.guide()?.related.map((code) => findErrorGuide(code)!) ?? [],
  );
  constructor() {
    const title = inject(Title),
      meta = inject(Meta),
      destroy = inject(DestroyRef);
    const originalTitle = title.getTitle();
    const originalDescription = meta.getTag('name="description"')?.content;
    const originalRobots = meta.getTag('name="robots"')?.content;
    effect(() => {
      const guide = this.guide();
      title.setTitle(
        guide
          ? `${guide.code}: ${guide.name} | Sapiovian`
          : this.requested()
            ? 'Error code not found | Sapiovian'
            : 'Error Encyclopedia | Sapiovian',
      );
      meta.updateTag({
        name: 'description',
        content:
          guide?.explanation ??
          'Understand Sapiovian error codes, common causes, recovery steps and developer troubleshooting.',
      });
      if (this.requested() && !guide)
        meta.updateTag({ name: 'robots', content: 'noindex' });
      else if (originalRobots)
        meta.updateTag({ name: 'robots', content: originalRobots });
      else meta.removeTag('name="robots"');
      this.copied.set(false);
      this.copyFailed.set(false);
    });
    destroy.onDestroy(() => {
      title.setTitle(originalTitle);
      if (originalDescription)
        meta.updateTag({ name: 'description', content: originalDescription });
      else meta.removeTag('name="description"');
      if (originalRobots)
        meta.updateTag({ name: 'robots', content: originalRobots });
      else meta.removeTag('name="robots"');
    });
  }
  count(area: string): number {
    return this.guides.filter((guide) => guide.area === area).length;
  }
  reset(): void {
    this.query.set('');
    this.area.set('All errors');
  }
  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.permalink());
      this.copied.set(true);
      this.copyFailed.set(false);
    } catch {
      this.copyFailed.set(true);
    }
  }
}
