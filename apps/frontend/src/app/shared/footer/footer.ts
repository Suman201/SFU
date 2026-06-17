import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'sfu-footer',
  standalone: true,
  templateUrl: './footer.html',
  styleUrl: './footer.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class Footer {}
