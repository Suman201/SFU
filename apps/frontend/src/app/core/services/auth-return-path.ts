/** Only internal, role-appropriate destinations may survive the login boundary. */
export function safeAuthReturnPath(
  value: string | null | undefined,
  role: 'teacher' | 'student',
): string | null {
  if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return null;
  try {
    const url = new URL(value, 'https://sapiovian.invalid');
    if (url.origin !== 'https://sapiovian.invalid') return null;
    const path = url.pathname.replace(/\/$/, '');
    if (
      path === '/calendar' ||
      path === `/class-session/${role}` ||
      path.startsWith(`/${role}/`)
    )
      return url.pathname + url.search + url.hash;
  } catch {
    /* Invalid destinations return to the account dashboard. */
  }
  return null;
}
