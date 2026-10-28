import { normalizeIntroVideoUrl } from './intro-video-url';
describe('Introduction video links', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=abcdefghijk',
    'https://youtu.be/abcdefghijk',
    'https://m.youtube.com/shorts/abcdefghijk',
    'https://vimeo.com/123456789/abc123',
    'https://player.vimeo.com/video/123456789?h=abc123',
  ]) it('accepts a direct video link '+url, () => { expect(normalizeIntroVideoUrl(url)).toBe(url); });
  for (const url of [
    'https://www.youtube.com/',
    'https://youtube.com/@teacher',
    'https://vimeo.com/',
    'https://youtube.com.example.com/watch?v=abcdefghijk',
    'http://youtu.be/abcdefghijk',
    'https://user:password@youtu.be/abcdefghijk',
    'javascript:alert(1)',
  ]) it('rejects non-video or unsafe links '+url, () => { expect(() => normalizeIntroVideoUrl(url)).toThrow(); });
});
