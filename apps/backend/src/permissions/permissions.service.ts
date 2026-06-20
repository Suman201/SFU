import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AccessPermissionDocument, AccessPermissionMongoDocument } from '../database/schemas';

@Injectable()
export class PermissionsService {
  constructor(@InjectModel(AccessPermissionDocument.name) private readonly permissions: Model<AccessPermissionMongoDocument>) {}

  async findAll(): Promise<Record<string, unknown>[]> {
    return (await this.permissions.find().sort({ module: 1, slug: 1 })).map((permission) => this.sanitize(permission));
  }

  async findOne(id: string): Promise<Record<string, unknown>> {
    const permission = await this.permissions.findById(id);
    if (!permission) throw new NotFoundException('Permission not found');
    return this.sanitize(permission);
  }

  private sanitize(permission: AccessPermissionMongoDocument): Record<string, unknown> {
    return {
      id: permission.id,
      name: permission.name,
      slug: permission.slug,
      module: permission.module,
      description: permission.description,
      createdAt: permission.createdAt,
      updatedAt: permission.updatedAt
    };
  }
}
