import { Component, inject, input, output, signal } from '@angular/core';
import { ProfileService } from '../../core/services/profile.service';
import type {
  TutorVerificationDocument,
  TutorVerificationKind,
} from '@native-sfu/contracts';
@Component({
  selector: 'sfu-tutor-verification',
  standalone: true,
  template: ` <section class="verification">
    <h3>Private verification documents</h3>
    <p>
      Upload identity evidence and support for the qualifications you list.
      Safeguarding evidence can be added when requested by your reviewer. These
      files are visible to you and authorised reviewers.
    </p>
    <label
      >Document type<select [value]="kind()" (change)="kind.set(value($event))">
        <option value="identity">Identity</option>
        <option value="qualification">Qualification</option>
        <option value="safeguarding">Safeguarding</option>
      </select></label
    >
    <label
      >Upload verification document<input
        type="file"
        accept="application/pdf,image/png,image/jpeg"
        [disabled]="busy()"
        (change)="upload($event)" /></label
    ><small
      >PDF, PNG or JPEG · Up to 10 MB. Unencrypted PDFs may contain up to 10
      pages.</small
    >
    @if (error()) {
      <p role="alert">{{ error() }}</p>
    }
    @if (busy()) {
      <p role="status">Saving private document…</p>
    }
    @for (doc of documents(); track doc.id) {
      <article>
        <header>
          <strong>{{ doc.kind }} · {{ doc.name }}</strong
          ><span>{{ doc.status }}</span>
        </header>
        <p>{{ doc.reviewNote || 'Awaiting reviewer verification.' }}</p>
        <small>{{
          doc.fileAvailable
            ? 'File retained until ' + date(doc.expiresAt)
            : 'File removed under the retention policy; the review record is retained.'
        }}</small>
        <footer>
          @if (doc.fileAvailable) {
            <button type="button" (click)="download(doc)" [disabled]="busy()">
              Download my document
            </button>
          }
          <button type="button" (click)="remove(doc)" [disabled]="busy()">
            Remove document
          </button>
        </footer>
      </article>
    }
    <p>
      Removing required evidence requires a new review before your profile can
      be public. Document uploads are saved immediately. Save your other profile
      changes before submitting.
    </p>
  </section>`,
  styles: [
    `
      :host {
        display: block;
      }
      .verification {
        margin-top: 24px;
        padding-top: 22px;
        border-top: 1px solid var(--line, #dce4de);
      }
      h3 {
        font-size: 18px;
        margin: 0 0 12px;
      }
      p {
        font-size: 12px;
        line-height: 1.7;
        color: var(--muted, #65766d);
      }
      label {
        display: grid;
        gap: 8px;
        font-size: 13px;
        margin: 16px 0;
      }
      select,
      input {
        font: inherit;
        width: 100%;
        box-sizing: border-box;
        padding: 10px;
        border: 1px solid var(--line, #dce4de);
        border-radius: 8px;
        background: var(--panel, #fff);
        color: inherit;
      }
      article {
        border: 1px solid var(--line, #dce4de);
        border-radius: 10px;
        padding: 16px;
        margin: 14px 0;
      }
      header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      header span {
        color: #458b73;
      }
      small {
        font-size: 11px;
        color: var(--muted, #65766d);
      }
      footer {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 14px;
      }
      button {
        font: inherit;
        font-size: 12px;
        padding: 8px 10px;
        border: 1px solid var(--line, #dce4de);
        border-radius: 7px;
        background: var(--panel, #fff);
        color: inherit;
        cursor: pointer;
      }
    `,
  ],
})
export class TutorVerification {
  private readonly api = inject(ProfileService);
  readonly documents = input<TutorVerificationDocument[]>([]);
  readonly changed = output<void>();
  protected readonly kind = signal<TutorVerificationKind>('identity');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected value(event: Event) {
    return (event.target as HTMLSelectElement).value as TutorVerificationKind;
  }
  protected date(value: string) {
    return new Date(value).toLocaleDateString();
  }
  protected upload(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      this.error.set('Choose a file up to 10 MB.');
      target.value = '';
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.api.uploadVerificationDocument(this.kind(), file).subscribe({
      next: () => {
        this.busy.set(false);
        target.value = '';
        this.changed.emit();
      },
      error: (e) => {
        this.busy.set(false);
        target.value = '';
        this.error.set(this.api.errorMessage(e));
      },
    });
  }
  protected download(doc: TutorVerificationDocument) {
    this.api
      .downloadVerificationDocument(doc.id)
      .subscribe({
        next: (blob) => downloadVerification(blob, doc),
        error: (e) => this.error.set(this.api.errorMessage(e)),
      });
  }
  protected remove(doc: TutorVerificationDocument) {
    this.busy.set(true);
    this.api.removeVerificationDocument(doc.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.changed.emit();
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(this.api.errorMessage(e));
      },
    });
  }
}
export function downloadVerification(
  blob: Blob,
  doc: TutorVerificationDocument,
) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${doc.kind}.${doc.mimeType === 'application/pdf' ? 'pdf' : doc.mimeType === 'image/png' ? 'png' : 'jpg'}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
