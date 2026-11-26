export const SOCIAL_USER_INDEXES = [
  { key: { googleSubject: 1 }, name: 'googleSubject_1', unique: true, sparse: true },
  { key: { appleSubject: 1 }, name: 'appleSubject_1', unique: true, sparse: true },
] as const;
export const SOCIAL_FLOW_INDEXES = [
  { key: { stateHash: 1 }, name: 'stateHash_1', unique: true },
  { key: { ticketHash: 1 }, name: 'ticketHash_1', unique: true, sparse: true },
  { key: { expiresAt: 1 }, name: 'expiresAt_1', expireAfterSeconds: 0 },
] as const;
