export const RECOVERY_USER_INDEXES = [
  { key: { passwordResetHash: 1 }, name: 'passwordResetHash_1', unique: true, sparse: true },
] as const;
export const RECOVERY_JOB_INDEXES = [
  { key: { state: 1, availableAt: 1, leaseUntil: 1 }, name: 'state_1_availableAt_1_leaseUntil_1' },
  { key: { expiresAt: 1 }, name: 'expiresAt_1', expireAfterSeconds: 0 },
] as const;
