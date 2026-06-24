import { IsIn, IsOptional, IsString } from 'class-validator';
import { RecordingScope } from '@native-sfu/contracts';

export class StartRecordingDto {
  @IsString()
  roomId!: string;

  @IsIn(['room', 'participant', 'screen'])
  scope!: RecordingScope;

  @IsOptional()
  @IsString()
  participantId?: string;
}
