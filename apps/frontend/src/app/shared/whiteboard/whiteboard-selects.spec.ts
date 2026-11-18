import { TestBed } from '@angular/core/testing';
import { Whiteboard } from './whiteboard';

describe('Whiteboard rendered dropdown state', () => {
  it('shows the current page template and menu settings after dynamic options render', async () => {
    await TestBed.configureTestingModule({ imports: [Whiteboard] }).compileComponents();
    const fixture = TestBed.createComponent(Whiteboard);
    try {
      fixture.detectChanges();
      const root: HTMLElement = fixture.nativeElement;
      const component = fixture.componentInstance as any;
      const grid = root.querySelector<HTMLButtonElement>('button[aria-label="Math Grid"]')!;
      const ruled = root.querySelector<HTMLButtonElement>('button[aria-label="Ruled Lines"]')!;
      expect(grid.getAttribute('aria-pressed')).toBe('true');
      ruled.click();
      fixture.detectChanges();
      expect(grid.getAttribute('aria-pressed')).toBe('false');
      expect(ruled.getAttribute('aria-pressed')).toBe('true');
      component.angleSnapDegrees.set(30);
      component.pdfExportMode.set('raster');
      (root.querySelector('[aria-label="Menu"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect((root.querySelector('[aria-label="Angle snap increment"]') as HTMLSelectElement).value).toBe('30');
      expect((root.querySelector('[aria-label="PDF export mode"]') as HTMLSelectElement).value).toBe('raster');
    } finally { fixture.destroy(); }
  });
});
