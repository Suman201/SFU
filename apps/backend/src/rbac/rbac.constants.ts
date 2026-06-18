export const SYSTEM_ROLES = ['SUPER_ADMIN', 'ADMIN', 'TEACHER', 'STUDENT'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const DEFAULT_PERMISSIONS = [
  'users:create',
  'users:read',
  'users:update',
  'users:delete',
  'roles:create',
  'roles:read',
  'roles:update',
  'roles:delete',
  'permissions:read',
  'permissions:assign',
  'rooms:create',
  'rooms:read',
  'rooms:update',
  'rooms:delete',
  'sessions:create',
  'sessions:read',
  'sessions:update',
  'sessions:delete',
  'recordings:start',
  'recordings:stop',
  'recordings:read',
  'recordings:delete',
  'moderation:mute',
  'moderation:kick',
  'moderation:ban',
  'analytics:read'
] as const;

export const ROLE_PERMISSION_MAP: Record<SystemRole, string[]> = {
  SUPER_ADMIN: [...DEFAULT_PERMISSIONS],
  ADMIN: DEFAULT_PERMISSIONS.filter((permission) => !permission.startsWith('roles:delete') && !permission.startsWith('users:delete')),
  TEACHER: ['rooms:create', 'rooms:read', 'rooms:update', 'sessions:create', 'sessions:read', 'recordings:start', 'recordings:stop', 'recordings:read', 'moderation:mute', 'moderation:kick'],
  STUDENT: ['rooms:read', 'sessions:read']
};

export function permissionModule(slug: string): string {
  return slug.split(':')[0] ?? 'platform';
}

export function humanizeSlug(slug: string): string {
  return slug
    .split(':')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
