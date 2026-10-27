import { resolveDesktopMediaUrl } from './desktop.service';

describe('Desktop recording media origin', () => {
  it('loads a relative signed media path from the configured backend origin', () => {
    expect(resolveDesktopMediaUrl('/api/v1/desktop/recordings/lesson/content?ticket=signed', 'https://api.example.test/api/v1')).toBe('https://api.example.test/api/v1/desktop/recordings/lesson/content?ticket=signed');
  });
  it('supports the native relative API base through the current loopback origin', () => {
    expect(resolveDesktopMediaUrl('/api/v1/desktop/recordings/lesson/content?ticket=signed', '/api/v1', 'http://127.0.0.1:51234')).toBe('http://127.0.0.1:51234/api/v1/desktop/recordings/lesson/content?ticket=signed');
  });
  it('rejects arbitrary origins and HTML paths', () => {
    expect(() => resolveDesktopMediaUrl('https://other.example.test/api/v1/desktop/recordings/lesson/content', 'https://api.example.test/api/v1')).toThrow();
    expect(() => resolveDesktopMediaUrl('/desktop/login', 'https://api.example.test/api/v1')).toThrow();
  });
  it('keeps native media on the existing loopback API proxy', () => {
    expect(resolveDesktopMediaUrl('/api/v1/desktop/recordings/lesson/content?ticket=signed', 'http://127.0.0.1:51234/api/v1')).toBe('http://127.0.0.1:51234/api/v1/desktop/recordings/lesson/content?ticket=signed');
  });
});
