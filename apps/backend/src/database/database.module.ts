import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AccessPermissionDocument,
  AccessPermissionSchema,
  AuditLogDocument,
  AuditLogSchema,
  ChatMessageDocument,
  ChatMessageSchema,
  ConsumerDocument,
  ConsumerSchema,
  EmailVerificationTokenDocument,
  EmailVerificationTokenSchema,
  ModerationDocument,
  ModerationSchema,
  ParticipantDocument,
  ParticipantSchema,
  PasswordResetTokenDocument,
  PasswordResetTokenSchema,
  PermissionDocument,
  PermissionSchema,
  ProducerDocument,
  ProducerSchema,
  RecordingDocument,
  RecordingSchema,
  RoleDocument,
  RolePermissionDocument,
  RolePermissionSchema,
  RoleSchema,
  RoomDocument,
  RoomSchema,
  SessionDocument,
  SessionSchema,
  UserRoleDocument,
  UserRoleSchema,
  UserDocument,
  UserSchema
} from './schemas';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserDocument.name, schema: UserSchema },
      { name: RoleDocument.name, schema: RoleSchema },
      { name: AccessPermissionDocument.name, schema: AccessPermissionSchema },
      { name: RolePermissionDocument.name, schema: RolePermissionSchema },
      { name: UserRoleDocument.name, schema: UserRoleSchema },
      { name: SessionDocument.name, schema: SessionSchema },
      { name: PasswordResetTokenDocument.name, schema: PasswordResetTokenSchema },
      { name: EmailVerificationTokenDocument.name, schema: EmailVerificationTokenSchema },
      { name: AuditLogDocument.name, schema: AuditLogSchema },
      { name: RoomDocument.name, schema: RoomSchema },
      { name: ParticipantDocument.name, schema: ParticipantSchema },
      { name: ProducerDocument.name, schema: ProducerSchema },
      { name: ConsumerDocument.name, schema: ConsumerSchema },
      { name: PermissionDocument.name, schema: PermissionSchema },
      { name: ModerationDocument.name, schema: ModerationSchema },
      { name: ChatMessageDocument.name, schema: ChatMessageSchema },
      { name: RecordingDocument.name, schema: RecordingSchema }
    ])
  ],
  exports: [MongooseModule]
})
export class DatabaseModule {}
