export function validatePasswordRecoveryConfig(config: Record<string, unknown>, errors: string[]): void {
  if (config.SMTP_ENABLED !== true) return;
  for (const field of ['FRONTEND_URL', 'ADMIN_PORTAL_URL']) {
    try {
      const url = new URL(String(config[field] ?? ''));
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && config.NODE_ENV !== 'production'))) throw new Error();
    } catch { errors.push(`${field} must be a fixed HTTPS origin for password recovery when SMTP_ENABLED=true (loopback HTTP is allowed outside production)`); }
  }
}
