import { ChangeDetectionStrategy, Component, input } from '@angular/core';
const paths = {
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  calendar: 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-7.87a4 4 0 0 1 0 7.75',
  book: 'M4 3h6a3 3 0 0 1 3 3v15a4 4 0 0 0-4-2H3V4a1 1 0 0 1 1-1Zm9 3a3 3 0 0 1 3-3h5v16h-4a4 4 0 0 0-4 2',
  layers: 'm12 3 10 5-10 5L2 8 12 3ZM2 12l10 5 10-5M2 16l10 5 10-5',
  check: 'm9 12 2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  video:
    'm16 8 6-4v16l-6-4M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z',
  archive: 'M3 3h18v4H3zM5 7v14h14V7M10 11h4',
  receipt: 'M4 3h16v19l-4-2-4 2-4-2-4 2V3Zm4 5h8m-8 4h8m-8 4h4',
  support:
    'M3 14v-3a9 9 0 0 1 18 0v3M3 12h4v7H3v-7Zm14 0h4v7h-4v-7Zm4 7a3 3 0 0 1-3 3h-4',
  mail: 'M3 5h18v14H3V5Zm0 1 9 7 9-7',
  tag: 'M20 13 11 22 2 13V2h11l9 9a2 2 0 0 1-2 2ZM7 7h.01',
  file: 'M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 12h8m-8 4h8',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Zm-4 10 3 3 5-6',
  alert: 'M12 8v5m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  help: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3m.1 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  chart: 'M3 3v18h18M7 16v-4m5 4V7m5 9v-6',
  folder: 'M3 5h6l2 2h10v13H3V5Z',
  chevron: 'm9 5 7 7-7 7',
  collapse: 'M9 4v16M4 4h16v16H4V4Zm11 5-3 3 3 3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M6 18 18 6',
  logout: 'M9 3H3v18h6m6-14 5 5-5 5M8 12h12',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  refresh: 'M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5m-4 9a8 8 0 0 0 14 2l3-3m0 5v-5h-5',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  external: 'M15 3h6v6m0-6L11 13M10 3H3v18h18v-7',
} as const;
export type AdminIconName = keyof typeof paths;
@Component({
  selector: 'admin-icon',
  standalone: true,
  template:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path [attr.d]="paths[name()]" /></svg>',
  styles: [
    ':host{display:inline-flex;flex:0 0 auto;width:18px;height:18px;vertical-align:middle}svg{width:100%;height:100%}',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminIcon {
  readonly name = input.required<AdminIconName>();
  readonly paths = paths;
}
