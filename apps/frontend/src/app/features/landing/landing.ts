import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Footer } from '../../shared/footer/footer';
import { Header } from '../../shared/header/header';

@Component({
  selector: 'sfu-landing',
  standalone: true,
  imports: [Footer, Header],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class Landing {}
