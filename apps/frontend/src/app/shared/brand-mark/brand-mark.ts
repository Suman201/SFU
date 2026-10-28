import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Canonical product mark, shared by the website and desktop app. */
@Component({
  selector: 'sfu-brand-mark',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template:
    '<img src="/assets/brand/sapiovian-mark.png" alt="" width="324" height="432" />',
  styles: [
    ':host { display: block; width: 100%; height: 100%; } img { display: block; width: 100%; height: 100%; object-fit: contain; } :host-context([data-theme=dark]) img { filter: brightness(0) invert(1); }',
  ],
})
export class BrandMark {}
