import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CLASSROOM_POLICY_PRESETS, type ClassroomPolicyPresetId } from '@native-sfu/contracts';
@Component({
  selector: 'sfu-classroom-policy-presets', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<section aria-label="Classroom policy presets"><h3>Classroom policy presets</h3><p>Apply a policy for future classes in this batch. Customize individual fields below.</p><div>@for (preset of presets; track preset.id) {<article><strong>{{ preset.name }}</strong><p>{{ preset.description }}</p><button class="button secondary" type="button" [disabled]="disabled()" (click)="presetSelected.emit(preset.id)">Apply {{ preset.name }} preset</button></article>}</div></section>`,
  styles: [`section{padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}h3{margin:0;font-size:16px}p{margin:7px 0 12px;color:var(--muted);font-size:13px;line-height:1.5}section>div{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}article{padding:12px;border:1px solid var(--line-soft);border-radius:8px}button{font-size:12px}button:focus-visible{outline:3px solid var(--focus-ring,#458b73);outline-offset:3px}@media(max-width:800px){section>div{grid-template-columns:1fr}}`]
})
export class ClassroomPolicyPresetsComponent {
  protected readonly presets = CLASSROOM_POLICY_PRESETS;
  readonly disabled = input(false);
  readonly presetSelected = output<ClassroomPolicyPresetId>();
}
