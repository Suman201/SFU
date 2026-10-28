import { Component, input } from '@angular/core';
import {
  teachingCategoryPath,
  type TeachingCatalogSnapshot,
  type TeacherTeachingArea,
} from '@native-sfu/contracts';
@Component({
  selector: 'sfu-teaching-areas-summary',
  standalone: true,
  template: `@if (areas().length) {
    <section class="teaching-areas" aria-label="Teaching areas">
      <h2>What I teach</h2>
      @for (area of areas(); track area.categoryId || 'other') {
        <article>
          <h3>{{ category(area) }}</h3>
          @if (subjects(area)) {
            <p>{{ subjects(area) }}</p>
          }
          <dl>
            <div>
              <dt>Academic level</dt>
              <dd>{{ names(area.levelIds, 'levels') }}</dd>
            </div>
            <div>
              <dt>Taught in</dt>
              <dd>{{ names(area.languageIds, 'languages') }}</dd>
            </div>
          </dl>
        </article>
      }
    </section>
  }`,
  styles: [
    `
      :host {
        display: block;
      }
      .teaching-areas {
        margin: 24px 0;
      }
      h2 {
        font-size: 20px;
        margin: 0 0 16px;
      }
      article {
        border-top: 1px solid var(--line, #dce4de);
        padding: 18px 0;
      }
      h3 {
        font-size: 15px;
        line-height: 1.6;
        margin: 0 0 6px;
      }
      p {
        font-size: 13px;
        line-height: 1.7;
        margin: 0 0 12px;
        overflow-wrap: anywhere;
      }
      dl {
        display: flex;
        gap: 18px 40px;
        flex-wrap: wrap;
        margin: 0;
      }
      dt {
        font-size: 11px;
        color: var(--muted, #68786d);
        margin-bottom: 5px;
      }
      dd {
        font-size: 13px;
        line-height: 1.6;
        margin: 0;
      }
    `,
  ],
})
export class TeachingAreasSummary {
  readonly areas = input<TeacherTeachingArea[]>([]);
  readonly catalog = input.required<TeachingCatalogSnapshot>();
  protected category(area: TeacherTeachingArea) {
    return area.categoryId
      ? teachingCategoryPath(this.catalog().categories, area.categoryId)
          .map((c) => c.name)
          .join(' › ') || 'Teaching area'
      : 'Other subjects';
  }
  protected subjects(area: TeacherTeachingArea) {
    return [
      ...this.catalog()
        .subjects.filter((s) => area.subjectIds.includes(s.id))
        .map((s) => s.name),
      ...area.otherSubjects,
    ].join(', ');
  }
  protected names(ids: string[], kind: 'levels' | 'languages') {
    return (
      (this.catalog()[kind] ?? [])
        .filter((e) => ids.includes(e.id))
        .map((e) => e.name)
        .join(', ') || 'Ask the teacher'
    );
  }
}
