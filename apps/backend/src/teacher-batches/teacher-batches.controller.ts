import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateTeacherBatchDto, UpdateTeacherBatchDto, UpdateTeacherBatchStatusDto } from './dto/teacher-batch.dto';
import { TeacherBatchesService } from './teacher-batches.service';

@ApiTags('teacher batches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TEACHER')
@Controller('teacher/batches')
export class TeacherBatchesController {
  constructor(private readonly batches: TeacherBatchesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a batch for the logged-in teacher' })
  create(@Body() dto: CreateTeacherBatchDto, @CurrentUser() teacher: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.batches.create(teacher.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the logged-in teacher's batches" })
  findAll(@CurrentUser() teacher: AuthenticatedUser): Promise<Record<string, unknown>[]> {
    return this.batches.findAll(teacher.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: "Get one of the logged-in teacher's batches" })
  findOne(@Param('id') id: string, @CurrentUser() teacher: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.batches.findOne(teacher.sub, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: "Update one of the logged-in teacher's batches" })
  update(@Param('id') id: string, @Body() dto: UpdateTeacherBatchDto, @CurrentUser() teacher: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.batches.update(teacher.sub, id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update batch status' })
  updateStatus(@Param('id') id: string, @Body() dto: UpdateTeacherBatchStatusDto, @CurrentUser() teacher: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.batches.updateStatus(teacher.sub, id, dto.status);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft delete a batch' })
  remove(@Param('id') id: string, @CurrentUser() teacher: AuthenticatedUser): Promise<void> {
    return this.batches.remove(teacher.sub, id);
  }
}
