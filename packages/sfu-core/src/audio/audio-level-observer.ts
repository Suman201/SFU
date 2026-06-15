export interface AudioLevel {
  participantId: string;
  level: number;
  speaking: boolean;
  updatedAt: number;
}

export class AudioLevelObserver {
  private readonly levels = new Map<string, AudioLevel>();

  update(participantId: string, level: number): AudioLevel {
    const normalized = Math.max(0, Math.min(1, level));
    const current: AudioLevel = {
      participantId,
      level: normalized,
      speaking: normalized > 0.12,
      updatedAt: Date.now()
    };
    this.levels.set(participantId, current);
    return current;
  }

  activeSpeaker(): AudioLevel | null {
    const recent = [...this.levels.values()].filter((level) => Date.now() - level.updatedAt < 3000 && level.speaking);
    recent.sort((a, b) => b.level - a.level);
    return recent[0] ?? null;
  }
}
