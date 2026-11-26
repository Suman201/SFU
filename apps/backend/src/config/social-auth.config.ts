import { createPrivateKey } from 'node:crypto';

/** OAuth callbacks and the frontend handoff must be fixed deployment URLs. */
export function validateSocialAuthConfig(config: Record<string, unknown>, errors: string[]): void {
  const production = config.NODE_ENV === 'production';
  for (const provider of ['GOOGLE', 'APPLE']) {
    if (config[`${provider}_AUTH_ENABLED`] !== true) continue;
    const fields = provider === 'GOOGLE' ? ['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URI'] : ['CLIENT_ID', 'TEAM_ID', 'KEY_ID', 'PRIVATE_KEY', 'REDIRECT_URI'];
    for (const field of fields) if (!String(config[`${provider}_AUTH_${field}`] ?? '').trim()) errors.push(`${provider}_AUTH_${field} is required when ${provider}_AUTH_ENABLED=true`);
    for (const field of [`${provider}_AUTH_REDIRECT_URI`, 'FRONTEND_URL']) {
      try {
        const url = new URL(String(config[field]));
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !production))) throw new Error();
        if (field === 'FRONTEND_URL' && url.pathname !== '/') throw new Error();
        if (field !== 'FRONTEND_URL' && url.pathname !== `/api/v1/auth/social/${provider.toLowerCase()}/callback`) throw new Error();
      } catch { errors.push(`${field} must be a fixed HTTPS URL (loopback HTTP is allowed outside production) with the documented callback path`); }
    }
    if (provider === 'APPLE' && config.APPLE_AUTH_PRIVATE_KEY) {
      try {
        const key = createPrivateKey(String(config.APPLE_AUTH_PRIVATE_KEY));
        if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
      } catch { errors.push('APPLE_AUTH_PRIVATE_KEY must be an EC P-256 private key in PEM format'); }
    }
  }
}
