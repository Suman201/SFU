import { Component, DestroyRef, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { DesktopDownload, DesktopReleaseCatalogue } from '@native-sfu/contracts';
import { Header } from '../../shared/header/header';
import { Footer } from '../../shared/footer/footer';
import { API_BASE_URL } from '../../core/services/app-environment';
@Component({ standalone: true, selector: 'sfu-download', imports: [Header, Footer, DatePipe], templateUrl: './download.html', styleUrl: './download.scss' })
export class DesktopDownloadPage implements OnInit {
  private readonly http = inject(HttpClient); private readonly destroy = inject(DestroyRef);
  protected readonly release = signal<DesktopReleaseCatalogue | null>(null); protected readonly loading = signal(true); protected readonly error = signal(''); protected readonly notice = signal('');
  ngOnInit() { this.load(); }
  protected load() { this.loading.set(true); this.error.set(''); this.http.get<{ data: DesktopReleaseCatalogue }>(API_BASE_URL + '/desktop/releases').pipe(takeUntilDestroyed(this.destroy)).subscribe({ next: result => { this.release.set(result.data); this.loading.set(false); }, error: () => { this.loading.set(false); this.error.set('Downloads could not be loaded. Please try again.'); } }); }
  protected platform(file: DesktopDownload) { return file.platform === 'mac' ? 'macOS' : 'Windows'; }
  protected arch(file: DesktopDownload) { return file.platform === 'mac' ? (file.arch === 'arm64' ? 'Apple silicon' : 'Intel') : (file.arch === 'arm64' ? 'ARM64' : 'Intel / AMD (x64)'); }
  protected size(bytes: number) { return (bytes / 1048576).toFixed(1) + ' MB'; }
  protected async copy(file: DesktopDownload) { try { await navigator.clipboard.writeText(file.sha256); this.notice.set('SHA-256 checksum copied for ' + this.platform(file) + ' ' + this.arch(file) + '.'); } catch { this.notice.set('Select and copy the checksum shown below.'); } }
}
