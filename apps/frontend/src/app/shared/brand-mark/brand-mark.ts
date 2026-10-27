import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Canonical product mark, shared by the website and desktop app. */
@Component({
  selector: 'sfu-brand-mark', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<img src="/assets/brand/edconnection-mark.svg" alt="" width="64" height="64" />',
  styles: [':host { display: block; width: 100%; height: 100%; } img { display: block; width: 100%; height: 100%; object-fit: contain; }']
})
export class BrandMark {}
