import { BrandLogo } from '../brand-mark/brand-logo';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'sfu-footer',
  standalone: true,
  imports: [BrandLogo, RouterLink],
  templateUrl: './footer.html',
  styleUrl: './footer.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class Footer {
  protected readonly year = new Date().getFullYear();
}
