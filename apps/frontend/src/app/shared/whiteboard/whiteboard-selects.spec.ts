import { TestBed } from '@angular/core/testing';
import { Whiteboard } from './whiteboard';

describe('Whiteboard rendered dropdown state', () => {
  it('selects the actual initial page template and menu settings after dynamic options render', async () => {
    await TestBed.configureTestingModule({ imports: [Whiteboard] }).compileComponents();
    const fixture = TestBed.createComponent(Whiteboard);
    try {
      fixture.detectChanges();
      const root: HTMLElement = fixture.nativeElement;
      const component = fixture.componentInstance as any;
      expect((root.querySelector('[aria-label="Board template"]') as HTMLSelectElement).value).toBe('grid');
      component.angleSnapDegrees.set(30);
      component.pdfExportMode.set('raster');
      (root.querySelector('[aria-label="Menu"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect((root.querySelector('[aria-label="Angle snap increment"]') as HTMLSelectElement).value).toBe('30');
      expect((root.querySelector('[aria-label="PDF export mode"]') as HTMLSelectElement).value).toBe('raster');
    } finally { fixture.destroy(); }
  });
});
