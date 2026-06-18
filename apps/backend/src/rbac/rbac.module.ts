import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AccessPermissionDocument,
  AccessPermissionSchema,
  RoleDocument,
  RolePermissionDocument,
  RolePermissionSchema,
  RoleSchema,
  UserDocument,
  UserRoleDocument,
  UserRoleSchema,
  UserSchema
} from '../database/schemas';
import { RbacSeederService } from './rbac-seeder.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RoleDocument.name, schema: RoleSchema },
      { name: AccessPermissionDocument.name, schema: AccessPermissionSchema },
      { name: RolePermissionDocument.name, schema: RolePermissionSchema },
      { name: UserRoleDocument.name, schema: UserRoleSchema },
      { name: UserDocument.name, schema: UserSchema }
    ])
  ],
  providers: [RbacSeederService],
  exports: [RbacSeederService]
})
export class RbacModule {}
