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
  PlatformEventDocument,
  PlatformEventSchema,
  PermissionDocument,
  PermissionSchema,
  ProducerDocument,
  ProducerSchema,
  RecordingDocument,
  RecordingSchema,
  RoomDocument,
  RoomIncidentEventDocument,
  RoomIncidentEventSchema,
  RoomSnapshotBundleDocument,
  RoomSnapshotBundleSchema,
  RoomSchema,
  UserDocument,
  UserSchema,
  WebhookDeliveryDocument,
  WebhookDeliverySchema,
  WebhookEndpointDocument,
  WebhookEndpointSchema
} from './schemas';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserDocument.name, schema: UserSchema },
      { name: RoomDocument.name, schema: RoomSchema },
      { name: RoomIncidentEventDocument.name, schema: RoomIncidentEventSchema },
      { name: RoomSnapshotBundleDocument.name, schema: RoomSnapshotBundleSchema },
      { name: PlatformEventDocument.name, schema: PlatformEventSchema },
      { name: WebhookEndpointDocument.name, schema: WebhookEndpointSchema },
      { name: WebhookDeliveryDocument.name, schema: WebhookDeliverySchema },
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
