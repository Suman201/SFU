export type DesktopReleasePlatform = 'mac' | 'win';
export type DesktopReleaseArch = 'x64' | 'arm64';
export interface DesktopDownload {
  platform: DesktopReleasePlatform;
  arch: DesktopReleaseArch;
  name: string;
  url: string;
  bytes: number;
  sha256: string;
  verification: 'signed' | 'signed-and-notarized';
}
export interface DesktopReleaseCatalogue {
  available: boolean;
  version?: string;
  publishedAt?: string;
  notes?: string;
  downloads: DesktopDownload[];
}
