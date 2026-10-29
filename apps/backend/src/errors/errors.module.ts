import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import {
  ErrorIncidentDocument,
  ErrorIncidentSchema,
} from './error-incident.schema';
import { ErrorsController, AdminErrorsController } from './errors.controller';
import { ErrorsService } from './errors.service';
@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: ErrorIncidentDocument.name, schema: ErrorIncidentSchema },
    ]),
  ],
  controllers: [ErrorsController, AdminErrorsController],
  providers: [ErrorsService],
  exports: [ErrorsService],
})
export class ErrorsModule {}
