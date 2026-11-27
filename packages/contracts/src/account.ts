import type { ProfileSettings, ProfileUser } from './profile.js';
export interface AccountSession {
  id: string;
  device: string;
  ipAddress?: string;
  signedInAt: string;
  expiresAt: string;
  current: boolean;
}
export interface AccountSessionPage { items: AccountSession[]; total: number; page: number; limit: number }
export interface AccountSecurity {
  email: string;
  emailVerified: boolean;
  hasPassword: boolean;
  googleLinked: boolean;
  appleLinked: boolean;
  emailDeliveryAvailable: boolean;
  pendingEmail?: { email: string; status: string; requestedAt: string };
}
export interface AccountOverview { profile: ProfileUser; security: AccountSecurity }
export type AccountPreferences = Pick<ProfileSettings, 'theme' | 'locale' | 'notifications' | 'privacy'>;
