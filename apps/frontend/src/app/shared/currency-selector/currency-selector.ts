import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CurrencyService } from '../../core/services/currency.service';

@Component({
  selector: 'sfu-currency-selector', standalone: true, imports: [FormsModule],
  template: `<label class="currency-choice"><span class="sr-only">Display currency</span><select aria-label="Display currency" [ngModel]="money.currency()" (ngModelChange)="money.select($event)">@for (code of money.currencies; track code) {<option [value]="code">{{code}}</option>}</select></label>@if(money.notice()){<small role="status">{{money.notice()}}</small>}`,
  styles: [`:host{display:inline-flex;align-items:center;position:relative}select{font:inherit;font-size:12px;font-weight:600;min-height:38px;max-width:84px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);color:var(--text);padding:6px;cursor:pointer}select:focus-visible{outline:2px solid var(--accent,#F26076);outline-offset:2px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}small{position:absolute;top:100%;right:0;width:200px;background:var(--panel);color:var(--text);border:1px solid var(--line);padding:8px;border-radius:var(--radius);font-size:11px}`],
})
export class CurrencySelector { protected readonly money = inject(CurrencyService); }
