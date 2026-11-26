import { ClassroomLocaleService } from './classroom-locale.service';
describe('classroom language preferences', () => {
  afterEach(() => localStorage.removeItem('sapiovian.classroom.locale'));
  it('persists a supported language while retaining a complete English fallback', () => {
    localStorage.removeItem('sapiovian.classroom.locale');
    const locale = new ClassroomLocaleService(); expect(locale.text('joinClass')).toBe('Join Class');
    locale.setLocale('hi'); expect(locale.text('joinClass')).toBe('कक्षा में शामिल हों');
    expect(new ClassroomLocaleService().locale()).toBe('hi');
    locale.setLocale('unknown'); expect(locale.locale()).toBe('hi');
    locale.setLocale('en'); expect(locale.text('teacherReconnecting')).toBe('Teacher reconnecting');
  });
});
