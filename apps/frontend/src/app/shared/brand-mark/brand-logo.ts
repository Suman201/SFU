import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { BrandMark } from './brand-mark';

/** Approved artwork and tagline shared by every web and desktop surface. */
@Component({
  selector: 'sfu-brand-logo',
  standalone: true,
  imports: [BrandMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<sfu-brand-mark aria-hidden="true" /><span class="brand-copy">
      <img
        class="wordmark"
        src="/assets/brand/sapiovian-wordmark.png"
        alt="Sapiovian"
        width="1384"
        height="312"
      />
      @if (tagline()) {
        <span class="tagline">Your curiosity. Their calling.</span>
      }
    </span>`,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        white-space: nowrap;
      }
      sfu-brand-mark {
        flex: 0 0 36px;
        width: 36px;
        height: 48px;
      }
      .brand-copy {
        display: grid;
        gap: 3px;
      }
      .wordmark {
        display: block;
        width: 166px;
        height: auto;
      }
      .tagline {
        color: var(--muted, #52665e);
        font-size: 10px;
        font-weight: 400;
        letter-spacing: 0;
        line-height: 1.2;
      }
      :host-context([data-theme='dark']) .wordmark {
        filter: brightness(0) invert(1);
      }
      @media (max-width: 360px) {
        :host {
          gap: 6px;
        }
        sfu-brand-mark {
          flex-basis: 31px;
          width: 31px;
          height: 42px;
        }
        .wordmark {
          width: 152px;
        }
        .tagline {
          font-size: 9px;
        }
      }
    `,
  ],
})
export class BrandLogo {
  readonly tagline = input(true);
}
