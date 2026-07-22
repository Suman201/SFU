import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hydrateSecretFiles } from './secret-file';

describe('secret file configuration', () => {
  it('hydrates a missing direct value from its corresponding file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'native-sfu-secret-'));
    const file = join(directory, 'jwt-access');
    writeFileSync(file, 'secret-from-mounted-file\n', { mode: 0o600 });

    try {
      const hydrated = hydrateSecretFiles({ JWT_ACCESS_SECRET_FILE: file });
      const direct = hydrateSecretFiles({
        JWT_ACCESS_SECRET: 'direct-secret',
        JWT_ACCESS_SECRET_FILE: file
      });
      expect(hydrated.JWT_ACCESS_SECRET).toBe('secret-from-mounted-file');
      expect(direct.JWT_ACCESS_SECRET).toBe('direct-secret');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
