import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ChatMessageDocument,
  ChatMessageSchema,
  ConsumerDocument,
  ConsumerSchema,
  ModerationDocument,
  ModerationSchema,
  ParticipantDocument,
  ParticipantSchema,
  PermissionDocument,
  PermissionSchema,
  ProducerDocument,
  ProducerSchema,
  RecordingDocument,
  RecordingSchema,
  RoomDocument,
  RoomSchema,
  UserDocument,
  UserSchema
} from './schemas';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserDocument.name, schema: UserSchema },
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
