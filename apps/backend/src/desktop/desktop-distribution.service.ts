import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { DesktopDownload, DesktopReleaseCatalogue } from '@native-sfu/contracts';

export function validateDesktopCatalogue(value: unknown, origins: string[]): DesktopReleaseCatalogue {
  const fail = (): never => { throw new Error('Invalid desktop release catalogue.'); };
  if (!value || typeof value !== 'object') return fail();
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1 || data.available !== true || typeof data.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(data.version) || typeof data.publishedAt !== 'string' || !Number.isFinite(Date.parse(data.publishedAt)) || Date.parse(data.publishedAt) > Date.now() + 300000 || !Array.isArray(data.downloads) || data.downloads.length !== 4 || typeof data.notes !== 'string' || data.notes.length > 2000) return fail();
  const allowed = new Set(origins.map(value => { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || url.pathname !== '/') return fail(); return url.origin; }));
  const seen = new Set<string>();
  const downloads: DesktopDownload[] = data.downloads.map((input: unknown) => {
    if (!input || typeof input !== 'object') return fail();
    const file = input as Record<string, unknown>, platform = file.platform, arch = file.arch;
    if ((platform !== 'mac' && platform !== 'win') || (arch !== 'x64' && arch !== 'arm64') || typeof file.name !== 'string' || file.name !== `Sapiovian Classroom-${data.version}-${platform}-${arch}.${platform === 'mac' ? 'dmg' : 'exe'}` || typeof file.url !== 'string' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 1 || Number(file.bytes) > 2147483648 || file.verification !== (platform === 'mac' ? 'signed-and-notarized' : 'signed')) return fail();
    const url = new URL(file.url);
    if (url.protocol !== 'https:' || !allowed.has(url.origin) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(`/releases/${data.version}/${platform}/${arch}/` + encodeURIComponent(file.name)) || /%2f|%5c/i.test(url.pathname)) return fail();
    const key = platform + '/' + arch; if (seen.has(key)) return fail(); seen.add(key);
    return { platform, arch, name: file.name, url: url.href, bytes: Number(file.bytes), sha256: file.sha256, verification: platform === 'mac' ? 'signed-and-notarized' : 'signed' };
  });
  return { available: true, version: data.version, publishedAt: data.publishedAt, notes: data.notes, downloads };
}
@Injectable()
export class DesktopDistributionService {
  private readonly logger = new Logger(DesktopDistributionService.name);
  private warned = false;
  constructor(private readonly config: ConfigService) {}
  async catalogue(): Promise<DesktopReleaseCatalogue> {
    const file = this.config.get<string>('desktopDistribution.manifestPath');
    const origins = this.config.get<string[]>('desktopDistribution.downloadOrigins', []);
    if (!file || !origins.length) return { available: false, downloads: [] };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 65536 || stat.size < 1) throw new Error('Invalid catalogue file.');
      const bytes = Buffer.alloc(65537); const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 65536) throw new Error('Oversized catalogue file.');
      const result = validateDesktopCatalogue(JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')), origins);
      this.warned = false; return result;
    } catch {
      if (!this.warned) { this.warned = true; this.logger.warn('Desktop downloads are unavailable because their release catalogue is missing or invalid.'); }
      return { available: false, downloads: [] };
    } finally { await handle?.close(); }
  }
}
