export enum Role {
  HOST = 'HOST',
  CO_HOST = 'CO_HOST',
  PARTICIPANT = 'PARTICIPANT',
  VIEWER = 'VIEWER'
}

export const MODERATOR_ROLES = new Set<Role>([Role.HOST, Role.CO_HOST]);
