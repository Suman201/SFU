import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { Role } from '@native-sfu/contracts';

export type UserMongoDocument = HydratedDocument<UserDocument>;
export type RoomMongoDocument = HydratedDocument<RoomDocument>;
export type ParticipantMongoDocument = HydratedDocument<ParticipantDocument>;
export type ProducerMongoDocument = HydratedDocument<ProducerDocument>;
export type ConsumerMongoDocument = HydratedDocument<ConsumerDocument>;
export type PermissionMongoDocument = HydratedDocument<PermissionDocument>;
export type AccessPermissionMongoDocument = HydratedDocument<AccessPermissionDocument>;
export type RoleMongoDocument = HydratedDocument<RoleDocument>;
export type RolePermissionMongoDocument = HydratedDocument<RolePermissionDocument>;
export type UserRoleMongoDocument = HydratedDocument<UserRoleDocument>;
export type SessionMongoDocument = HydratedDocument<SessionDocument>;
export type PasswordResetTokenMongoDocument = HydratedDocument<PasswordResetTokenDocument>;
export type EmailVerificationTokenMongoDocument = HydratedDocument<EmailVerificationTokenDocument>;
export type AuditLogMongoDocument = HydratedDocument<AuditLogDocument>;
export type ModerationMongoDocument = HydratedDocument<ModerationDocument>;
export type ChatMessageMongoDocument = HydratedDocument<ChatMessageDocument>;
export type RecordingMongoDocument = HydratedDocument<RecordingDocument>;

@Schema({ collection: 'users', timestamps: true })
export class UserDocument {
  @Prop({ trim: true, maxlength: 120 })
  name?: string;

  @Prop({ required: true, trim: true, maxlength: 120 })
  displayName!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true, maxlength: 254 })
  email!: string;

  @Prop({ trim: true, maxlength: 40 })
  phone?: string;

  @Prop({ required: true, select: false })
  passwordHash!: string;

  @Prop({ type: [String], default: ['STUDENT'] })
  roles!: string[];

  @Prop({ type: [String], default: [] })
  permissions!: string[];

  @Prop({ required: true, enum: ['active', 'inactive', 'suspended', 'invited'], default: 'active', index: true })
  status!: 'active' | 'inactive' | 'suspended' | 'invited';

  @Prop({ default: false })
  disabled!: boolean;

  @Prop({ type: Date })
  emailVerifiedAt?: Date;

  @Prop({ type: Date })
  lastLoginAt?: Date;

  @Prop({ type: Date, index: true })
  deletedAt?: Date;

  @Prop({ type: [String], default: [] })
  refreshTokenIds!: string[];

  createdAt!: Date;
  updatedAt!: Date;
}

export const UserSchema = SchemaFactory.createForClass(UserDocument);
UserSchema.index({ disabled: 1 });
UserSchema.index({ status: 1, deletedAt: 1 });

@Schema({ collection: 'roles', timestamps: true })
export class RoleDocument {
  @Prop({ required: true, trim: true, maxlength: 120 })
  name!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true, maxlength: 80 })
  slug!: string;

  @Prop({ trim: true, maxlength: 500 })
  description?: string;

  @Prop({ default: false })
  isSystem!: boolean;

  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active', index: true })
  status!: 'active' | 'inactive';

  createdAt!: Date;
  updatedAt!: Date;
}

export const RoleSchema = SchemaFactory.createForClass(RoleDocument);

@Schema({ collection: 'permissions', timestamps: true })
export class AccessPermissionDocument {
  @Prop({ required: true, trim: true, maxlength: 120 })
  name!: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true, maxlength: 120 })
  slug!: string;

  @Prop({ required: true, lowercase: true, trim: true, maxlength: 80, index: true })
  module!: string;

  @Prop({ trim: true, maxlength: 500 })
  description?: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AccessPermissionSchema = SchemaFactory.createForClass(AccessPermissionDocument);
AccessPermissionSchema.index({ module: 1, slug: 1 });

@Schema({ collection: 'role_permissions', timestamps: true })
export class RolePermissionDocument {
  @Prop({ required: true, index: true })
  roleId!: string;

  @Prop({ required: true, index: true })
  permissionId!: string;

  @Prop({ required: true, index: true })
  permissionSlug!: string;
}

export const RolePermissionSchema = SchemaFactory.createForClass(RolePermissionDocument);
RolePermissionSchema.index({ roleId: 1, permissionId: 1 }, { unique: true });

@Schema({ collection: 'user_roles', timestamps: true })
export class UserRoleDocument {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, index: true })
  roleId!: string;

  @Prop({ required: true, index: true })
  roleSlug!: string;
}

export const UserRoleSchema = SchemaFactory.createForClass(UserRoleDocument);
UserRoleSchema.index({ userId: 1, roleId: 1 }, { unique: true });

@Schema({ collection: 'sessions', timestamps: true })
export class SessionDocument {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, select: false })
  refreshTokenHash!: string;

  @Prop({ required: true, unique: true, index: true })
  refreshTokenJti!: string;

  @Prop({ trim: true, maxlength: 100 })
  ipAddress?: string;

  @Prop({ trim: true, maxlength: 500 })
  userAgent?: string;

  @Prop({ required: true, index: true })
  expiresAt!: Date;

  @Prop({ type: Date, index: true })
  revokedAt?: Date;
}

export const SessionSchema = SchemaFactory.createForClass(SessionDocument);
SessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: 1 });

@Schema({ collection: 'password_reset_tokens', timestamps: true })
export class PasswordResetTokenDocument {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, unique: true, index: true })
  tokenHash!: string;

  @Prop({ required: true, index: true })
  expiresAt!: Date;

  @Prop({ type: Date })
  usedAt?: Date;
}

export const PasswordResetTokenSchema = SchemaFactory.createForClass(PasswordResetTokenDocument);

@Schema({ collection: 'email_verification_tokens', timestamps: true })
export class EmailVerificationTokenDocument {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, unique: true, index: true })
  tokenHash!: string;

  @Prop({ required: true, index: true })
  expiresAt!: Date;

  @Prop({ type: Date })
  usedAt?: Date;
}

export const EmailVerificationTokenSchema = SchemaFactory.createForClass(EmailVerificationTokenDocument);

@Schema({ collection: 'audit_logs', timestamps: true })
export class AuditLogDocument {
  @Prop({ index: true })
  actorId?: string;

  @Prop({ required: true, index: true })
  action!: string;

  @Prop({ index: true })
  targetType?: string;

  @Prop({ index: true })
  targetId?: string;

  @Prop({ trim: true, maxlength: 100 })
  ipAddress?: string;

  @Prop({ trim: true, maxlength: 500 })
  userAgent?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLogDocument);
AuditLogSchema.index({ actorId: 1, action: 1, createdAt: -1 });

@Schema({ _id: false })
export class RoomSettingsDocument {
  @Prop({ required: true, default: false })
  locked!: boolean;

  @Prop({ required: true, default: false })
  waitingRoomEnabled!: boolean;

  @Prop({ required: true, default: false })
  joinApprovalRequired!: boolean;

  @Prop({ required: true, enum: ['public', 'private', 'invite-only'], default: 'public' })
  visibility!: 'public' | 'private' | 'invite-only';

  @Prop({ required: true, min: 1, max: 1000, default: 100 })
  maxParticipants!: number;

  @Prop({ required: true, default: false })
  recordingEnabled!: boolean;

  @Prop({ required: true, default: true })
  chatEnabled!: boolean;
}

export const RoomSettingsSchema = SchemaFactory.createForClass(RoomSettingsDocument);

@Schema({ _id: false })
export class RoomMediaStateDocument {
  @Prop({ required: true, enum: ['active', 'failed'], default: 'active' })
  status!: 'active' | 'failed';

  @Prop()
  failedAt?: Date;

  @Prop()
  failureReason?: string;

  @Prop()
  failureMessage?: string;

  @Prop()
  workerId?: string;
}

export const RoomMediaStateSchema = SchemaFactory.createForClass(RoomMediaStateDocument);

@Schema({ collection: 'rooms', timestamps: true })
export class RoomDocument {
  @Prop({ required: true, trim: true, maxlength: 160 })
  name!: string;

  @Prop({ required: true, index: true })
  hostId!: string;

  @Prop({ type: RoomSettingsSchema, required: true })
  settings!: RoomSettingsDocument;

  @Prop({ type: RoomMediaStateSchema, default: () => ({ status: 'active' }) })
  mediaState!: RoomMediaStateDocument;

  @Prop({ type: [String], default: [] })
  invitedUserIds!: string[];

  @Prop({ type: Date })
  closedAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const RoomSchema = SchemaFactory.createForClass(RoomDocument);
RoomSchema.index({ name: 'text' });
RoomSchema.index({ hostId: 1, closedAt: 1 });
RoomSchema.index({ 'settings.visibility': 1, closedAt: 1 });

@Schema({ collection: 'participants', timestamps: true })
export class ParticipantDocument {
  @Prop({ required: true, index: true })
  roomId!: string;

  @Prop({ index: true })
  userId?: string;

  @Prop({ required: true, trim: true, maxlength: 120 })
  displayName!: string;

  @Prop({ required: true, index: true })
  socketId!: string;

  @Prop({ required: true, enum: Object.values(Role), default: Role.PARTICIPANT })
  role!: Role;

  @Prop({ default: true })
  audioEnabled!: boolean;

  @Prop({ default: true })
  videoEnabled!: boolean;

  @Prop({ default: false })
  screenSharing!: boolean;

  @Prop({ default: false })
  handRaised!: boolean;

  @Prop({ default: true, index: true })
  admitted!: boolean;

  @Prop({ default: Date.now })
  joinedAt!: Date;

  @Prop({ default: Date.now })
  lastSeenAt!: Date;

  @Prop({ type: Date })
  leftAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ParticipantSchema = SchemaFactory.createForClass(ParticipantDocument);
ParticipantSchema.index({ roomId: 1, userId: 1, leftAt: 1 });
ParticipantSchema.index({ roomId: 1, socketId: 1 }, { unique: true, partialFilterExpression: { leftAt: { $exists: false } } });
ParticipantSchema.index({ roomId: 1, role: 1 });
ParticipantSchema.index({ roomId: 1, admitted: 1, leftAt: 1 });

@Schema({ collection: 'participant_permissions', timestamps: true })
export class PermissionDocument {
  @Prop({ required: true, index: true })
  roomId!: string;

  @Prop({ required: true, index: true })
  participantId!: string;

  @Prop({ default: true })
  canPublishAudio!: boolean;

  @Prop({ default: true })
  canPublishVideo!: boolean;

  @Prop({ default: true })
  canShareScreen!: boolean;

  @Prop({ default: true })
  canChat!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const PermissionSchema = SchemaFactory.createForClass(PermissionDocument);
PermissionSchema.index({ roomId: 1, participantId: 1 }, { unique: true });

@Schema({ collection: 'producers', timestamps: true })
export class ProducerDocument {
  @Prop({ required: true, index: true })
  roomId!: string;

  @Prop({ required: true, index: true })
  participantId!: string;

  @Prop({ required: true, enum: ['audio', 'video', 'screen'] })
  kind!: 'audio' | 'video' | 'screen';

  @Prop({ required: true, index: true })
  transportId!: string;

  @Prop({ index: true })
  nodeId?: string;

  @Prop({ min: 0.1, max: 10, default: 1 })
  priority!: number;

  @Prop({ type: Object, required: true })
  rtpParameters!: Record<string, unknown>;

  @Prop({ type: Object })
  dynacastState?: Record<string, unknown>;

  @Prop({ type: Object })
  svcState?: Record<string, unknown>;

  @Prop({ required: true, enum: ['live', 'paused', 'closed'], default: 'live' })
  status!: 'live' | 'paused' | 'closed';

  @Prop({ type: Date })
  closedAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ProducerSchema = SchemaFactory.createForClass(ProducerDocument);
ProducerSchema.index({ roomId: 1, kind: 1, status: 1 });
ProducerSchema.index({ participantId: 1, status: 1 });
ProducerSchema.index({ roomId: 1, nodeId: 1, status: 1 });

@Schema({ collection: 'consumers', timestamps: true })
export class ConsumerDocument {
  @Prop({ required: true, index: true })
  roomId!: string;

  @Prop({ required: true, index: true })
  producerId!: string;

  @Prop({ required: true, index: true })
  participantId!: string;

  @Prop({ required: true, index: true })
  transportId!: string;

  @Prop({ min: 0.1, max: 10, default: 1 })
  priority!: number;

  @Prop({ enum: ['low', 'medium', 'high'] })
  preferredLayer?: 'low' | 'medium' | 'high';

  @Prop({ type: Object })
  preferredLayers?: Record<string, unknown>;

  @Prop({ type: Object })
  currentLayers?: Record<string, unknown>;

  @Prop({ type: Object })
  targetLayers?: Record<string, unknown>;

  @Prop({ type: Object })
  preferredSvcLayers?: Record<string, unknown>;

  @Prop({ type: Object })
  currentSvcLayers?: Record<string, unknown>;

  @Prop({ type: Object })
  targetSvcLayers?: Record<string, unknown>;

  @Prop()
  layerSwitchReason?: string;

  @Prop({ type: Date })
  layerSwitchedAt?: Date;

  @Prop({ type: Object, required: true })
  rtpParameters!: Record<string, unknown>;

  @Prop({ required: true, enum: ['live', 'paused', 'closed'], default: 'live' })
  status!: 'live' | 'paused' | 'closed';

  @Prop({ type: Date })
  closedAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ConsumerSchema = SchemaFactory.createForClass(ConsumerDocument);
ConsumerSchema.index({ roomId: 1, participantId: 1, status: 1 });
ConsumerSchema.index({ producerId: 1, status: 1 });

@Schema({ collection: 'moderation', timestamps: true })
export class ModerationDocument {
  @Prop({ required: true, index: true })
  roomId!: string;

  @Prop({ required: true, index: true })
  participantId!: string;

  @Prop({ index: true })
  userId?: string;

  @Prop({ required: true, enum: ['kick', 'ban', 'shadow-mute', 'force-mute', 'disable-camera', 'stop-screen'] })
  action!: 'kick' | 'ban' | 'shadow-mute' | 'force-mute' | 'disable-camera' | 'stop-screen';

  @Prop({ required: true })
  actorId!: string;

  @Prop({ trim: true, maxlength: 500 })
  reason?: string;

  @Prop({ default: true })
  active!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ModerationSchema = SchemaFactory.createForClass(ModerationDocument);
ModerationSchema.index({ roomId: 1, participantId: 1, action: 1, active: 1 });
ModerationSchema.index({ roomId: 1, userId: 1, action: 1, active: 1 });

@Schema({ collection: 'chat', timestamps: true })
export class ChatMessageDocument {
  @Prop({ required: true, index: true })
  roomId!: string;

  @Prop({ required: true, index: true })
  senderId!: string;

  @Prop({ index: true })
  recipientId?: string;

  @Prop({ required: true, trim: true, maxlength: 4000 })
  message!: string;

  @Prop({ default: false })
  shadowMuted!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessageDocument);
ChatMessageSchema.index({ roomId: 1, createdAt: -1 });
ChatMessageSchema.index({ roomId: 1, senderId: 1, createdAt: -1 });
ChatMessageSchema.index({ roomId: 1, recipientId: 1, createdAt: -1 });

@Schema({ collection: 'recordings', timestamps: true })
export class RecordingDocument {
  @Prop({ required: true, index: true })
  roomId!: string;

  @Prop({ index: true })
  participantId?: string;

  @Prop({ required: true, enum: ['room', 'participant', 'screen'] })
  scope!: 'room' | 'participant' | 'screen';

  @Prop({ required: true, enum: ['starting', 'recording', 'stopped', 'failed'], default: 'starting' })
  status!: 'starting' | 'recording' | 'stopped' | 'failed';

  @Prop({ required: true, enum: ['local', 's3'], default: 'local' })
  storageDriver!: 'local' | 's3';

  @Prop()
  path?: string;

  @Prop()
  downloadUrl?: string;

  @Prop({ default: Date.now })
  startedAt!: Date;

  @Prop()
  stoppedAt?: Date;

  createdAt!: Date;
  updatedAt!: Date;
}

export const RecordingSchema = SchemaFactory.createForClass(RecordingDocument);
RecordingSchema.index({ roomId: 1, status: 1 });
RecordingSchema.index({ roomId: 1, participantId: 1, startedAt: -1 });
