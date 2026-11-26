import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ClassroomLocaleService } from '../../core/services/classroom-locale.service';

@Component({
  selector: 'sfu-classroom-language', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<select [attr.aria-label]="i18n.text('language')" [value]="i18n.locale()" (change)="i18n.setLocale($any($event.target).value)"><option value="en" lang="en">English</option><option value="hi" lang="hi">हिन्दी</option></select>`,
  styles: [`:host{display:inline-flex;max-width:100%}select{max-width:100%;min-height:36px;padding:6px 8px;border:1px solid var(--line,#cadbd1);border-radius:7px;background:var(--control-bg,#fff);color:var(--text,#18392e);font:inherit;font-size:12px}select:focus-visible{outline:3px solid #458b73;outline-offset:2px}`]
})
export class ClassroomLanguageComponent { protected readonly i18n = inject(ClassroomLocaleService); }
