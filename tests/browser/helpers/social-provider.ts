import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

/** Local provider simulator; application token exchange and JWT validation still run unchanged. */
export async function startSocialProvider() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const appleKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const codes = new Map<string, { provider: string; params: URLSearchParams; email: string; subject: string; invalid?: string }>();
  const requests: { provider: string; params: URLSearchParams }[] = [];
  const json = (value: unknown) => JSON.stringify(value);
  const encode = (value: unknown) => Buffer.from(json(value)).toString('base64url');
  const jwt = (claims: unknown) => {
    const input = encode({ alg: 'RS256', kid: 'synthetic-provider-key' }) + '.' + encode(claims);
    return input + '.' + sign('sha256', Buffer.from(input), keys.privateKey).toString('base64url');
  };
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://127.0.0.1');
      const provider = url.pathname.split('/')[1]!;
      if (url.pathname.endsWith('/authorize')) {
        const params = url.searchParams;
        if (!params.get('state') || !params.get('nonce') || params.get('response_type') !== 'code' || (provider === 'google' && params.get('code_challenge_method') !== 'S256') || (provider === 'apple' && params.get('response_mode') !== 'form_post')) throw Error('Missing OAuth protections');
        requests.push({ provider, params });
        const code = randomBytes(24).toString('hex');
        codes.set(code, { provider, params, email: params.get('fixture_email')!, subject: params.get('fixture_subject')!, invalid: params.get('fixture_invalid') ?? undefined });
        res.setHeader('content-type', 'text/html');
        const fields = params.get('fixture_cancel') ? { state: params.get('state')!, error: 'access_denied' } : { state: params.get('state')!, code, ...(provider === 'apple' ? { user: json({ name: { firstName: 'Apple', lastName: 'Learner' }, email: 'unsigned@example.test' }) } : {}) };
        res.end(`<html lang="en"><title>Synthetic ${provider} consent</title><body><h1>Local provider consent</h1><form action="${escape(params.get('redirect_uri')!)}" method="${provider === 'apple' ? 'POST' : 'GET'}">${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(value)}">`).join('')}<button>Authorize test account</button></form></body></html>`);
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/keys')) { res.end(json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic-provider-key', alg: 'RS256', use: 'sig' }] })); return; }
      if (url.pathname.endsWith('/token')) {
        let body = ''; for await (const chunk of req) body += chunk;
        const params = new URLSearchParams(body), entry = codes.get(params.get('code')!);
        codes.delete(params.get('code')!);
        if (!entry || entry.provider !== provider || params.get('redirect_uri') !== entry.params.get('redirect_uri') || params.get('client_id') !== provider + '-fixture-client' || params.get('grant_type') !== 'authorization_code') throw Error('Invalid code');
        if (provider === 'google') {
          if (params.get('client_secret') !== 'synthetic-google-client-secret' || createHash('sha256').update(params.get('code_verifier')!).digest('base64url') !== entry.params.get('code_challenge')) throw Error('Invalid PKCE');
        } else {
          const [header, payload, signature] = params.get('client_secret')!.split('.');
          const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
          if (JSON.parse(Buffer.from(header!, 'base64url').toString()).alg !== 'ES256' || claims.iss !== 'TESTTEAMID' || claims.sub !== 'apple-fixture-client' || claims.aud !== 'https://appleid.apple.com' || !verify('sha256', Buffer.from(header + '.' + payload), { key: appleKeys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))) throw Error('Invalid Apple client secret');
        }
        const now = Math.floor(Date.now()/1000);
        const claims: Record<string, unknown> = { sub: entry.subject, email: entry.email, email_verified: provider === 'apple' ? 'true' : true, name: 'Google Learner', nonce: entry.params.get('nonce'), iss: provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com', aud: provider + '-fixture-client', iat: now, exp: now + 300 };
        if (entry.invalid === 'nonce') claims.nonce = 'wrong-nonce';
        if (entry.invalid === 'audience') claims.aud = 'another-client';
        if (entry.invalid === 'unverified') claims.email_verified = false;
        res.end(json({ id_token: jwt(claims), access_token: 'unused-provider-access-token', token_type: 'Bearer' })); return;
      }
      res.statusCode = 404; res.end('{}');
    } catch { res.statusCode = 400; res.end(json({ error: 'invalid_grant' })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${address.port}`, requests,
    applePrivateKey: appleKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    stop: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
