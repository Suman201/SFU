import { ReplayProtectionError, ReplayWindow } from './replay-window';

describe('ReplayWindow', () => {
  it('accepts new indexes and rejects duplicates', () => {
    const replay = new ReplayWindow();

    replay.accept(10n);

    expect(() => replay.accept(10n)).toThrow(ReplayProtectionError);
  });

  it('accepts in-window out-of-order indexes once', () => {
    const replay = new ReplayWindow();

    replay.accept(10n);
    replay.accept(8n);

    expect(() => replay.accept(8n)).toThrow(ReplayProtectionError);
  });

  it('rejects indexes outside the window', () => {
    const replay = new ReplayWindow(4);

    replay.accept(10n);

    expect(() => replay.accept(5n)).toThrow(ReplayProtectionError);
  });
});
