import { PartialType } from '@nestjs/swagger';
import { CreateIngestDto } from './create-ingest.dto';

export class UpdateIngestDto extends PartialType(CreateIngestDto) {}
