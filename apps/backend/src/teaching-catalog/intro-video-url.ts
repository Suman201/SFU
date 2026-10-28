import { BadRequestException } from '@nestjs/common';
export function normalizeIntroVideoUrl(input: string): string {
  const value = input.trim();
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Paste a valid YouTube or Vimeo video link.');
  }
  const host = url.hostname.toLowerCase();
  let id = '';
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host))
    id =
      url.pathname === '/watch'
        ? url.searchParams.get('v') || ''
        : url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)\/?$/)?.[1] ||
          '';
  if (host === 'youtu.be') id = url.pathname.slice(1).replace(/\/$/, '');
  const youtube = /^[a-zA-Z0-9_-]{11}$/.test(id);
  const vimeo =
    (['vimeo.com', 'www.vimeo.com'].includes(host) &&
      /^\/\d+(?:\/[a-zA-Z0-9]+)?\/?$/.test(url.pathname)) ||
    (host === 'player.vimeo.com' && /^\/video\/\d+\/?$/.test(url.pathname));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    (!youtube && !vimeo)
  )
    throw new BadRequestException(
      'Use a direct HTTPS YouTube or Vimeo video link, not a channel or homepage.',
    );
  return url.toString();
}
