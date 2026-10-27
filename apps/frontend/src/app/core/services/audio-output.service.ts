import { Injectable, signal } from '@angular/core';

const SPEAKER_KEY = 'native-sfu.preferred-speaker-device';

/** One speaker preference routes live classroom media and recording playback on both web and desktop. */
@Injectable({ providedIn: 'root' })
export class AudioOutputService {
  readonly selectedDevice = signal<string | null>(this.savedDevice());
  readonly error = signal('');
  private readonly players = new Set<HTMLMediaElement>();
  private changes: Promise<void> = Promise.resolve();

  register(player: HTMLMediaElement): () => void {
    this.players.add(player);
    this.changes = this.changes.then(async () => {
      if (!this.players.has(player)) return;
      try { await this.route(player, this.selectedDevice() ?? ''); }
      catch {
        this.error.set('Your saved speaker is unavailable. Choose a speaker in Device Setup.');
        await this.route(player, '').catch(() => undefined);
      }
    });
    return () => this.players.delete(player);
  }

  select(deviceId: string | null | undefined): Promise<void> {
    const next = deviceId?.trim() ?? '';
    const change = this.changes.then(async () => {
      const previous = this.selectedDevice() ?? '';
      const players = this.players.size ? [...this.players] : [document.createElement('audio')];
      try {
        await Promise.all(players.map((player) => this.route(player, next)));
        this.selectedDevice.set(next || null);
        try { if (next) localStorage.setItem(SPEAKER_KEY, next); else localStorage.removeItem(SPEAKER_KEY); } catch { /* Audio remains usable without preference persistence. */ }
        this.error.set('');
      } catch (error) {
        await Promise.allSettled(players.map((player) => this.route(player, previous)));
        this.error.set('The speaker could not be selected. Check that it is connected and allowed, then try again.');
        throw error;
      }
    });
    this.changes = change.catch(() => undefined);
    return change;
  }

  private async route(player: HTMLMediaElement, id: string): Promise<void> {
    if (typeof player.setSinkId !== 'function') {
      if (id) throw new Error('This browser uses the system speaker. Change the output in your device sound settings.');
      return;
    }
    await player.setSinkId(id);
  }

  private savedDevice(): string | null {
    try { return localStorage.getItem(SPEAKER_KEY); } catch { return null; }
  }
}
