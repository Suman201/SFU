import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, ClientSession, Model } from 'mongoose';
import {
  BatchDocument,
  BatchMongoDocument,
  BatchScheduleDocument,
  BatchScheduleMongoDocument,
  BatchStatus,
  BatchWeekday
} from '../database/schemas';
import { BatchScheduleDto, CreateTeacherBatchDto, UpdateTeacherBatchDto } from './dto/teacher-batch.dto';

interface BatchWithSchedules {
  batch: BatchMongoDocument;
  schedules: BatchScheduleMongoDocument[];
}

@Injectable()
export class TeacherBatchesService {
  constructor(
    @InjectModel(BatchDocument.name) private readonly batches: Model<BatchMongoDocument>,
    @InjectModel(BatchScheduleDocument.name) private readonly schedules: Model<BatchScheduleMongoDocument>,
    @InjectConnection() private readonly connection: Connection
  ) {}

  async create(teacherId: string, dto: CreateTeacherBatchDto): Promise<Record<string, unknown>> {
    const schedule = this.normalizeSchedule(dto.schedule);
    await this.assertUniqueBatch(teacherId, dto.name, dto.year);
    const dates = this.yearDates(dto.year);

    return this.withTransaction(async (session) => {
      const [batch] = await this.batches.create(
        [
          {
            name: dto.name.trim(),
            courseId: this.optionalTrim(dto.courseId),
            courseName: this.optionalTrim(dto.courseName),
            teacherId,
            year: dto.year,
            startDate: dates.startDate,
            endDate: dates.endDate,
            maxCapacity: dto.maxCapacity,
            status: 'ACTIVE'
          }
        ],
        { session }
      );
      if (!batch) {
        throw new BadRequestException('Batch could not be created.');
      }
      await this.schedules.insertMany(
        schedule.map((item) => ({ batchId: batch.id, dayOfWeek: item.dayOfWeek, startTime: item.startTime })),
        { session }
      );
      return this.findOne(teacherId, batch.id, session);
    });
  }

  async findAll(teacherId: string): Promise<Record<string, unknown>[]> {
    const batches = await this.batches.find({ teacherId, deletedAt: { $exists: false } }).sort({ createdAt: -1 });
    const scheduleMap = await this.scheduleMap(batches.map((batch) => batch.id));
    return batches.map((batch) => this.serialize(batch, scheduleMap.get(batch.id) ?? []));
  }

  async findOne(teacherId: string, id: string, session?: ClientSession): Promise<Record<string, unknown>> {
    const data = await this.findOwnedWithSchedules(teacherId, id, session);
    return this.serialize(data.batch, data.schedules);
  }

  async update(teacherId: string, id: string, dto: UpdateTeacherBatchDto): Promise<Record<string, unknown>> {
    const existing = await this.findOwnedBatch(teacherId, id);
    const nextName = dto.name?.trim() ?? existing.name;
    const nextYear = dto.year ?? existing.year;
    const schedule = dto.schedule ? this.normalizeSchedule(dto.schedule) : undefined;

    if (nextName !== existing.name || nextYear !== existing.year) {
      await this.assertUniqueBatch(teacherId, nextName, nextYear, id);
    }

    const update: Partial<BatchDocument> = {};
    if (dto.name !== undefined) update.name = nextName;
    if (dto.courseId !== undefined) update.courseId = this.optionalTrim(dto.courseId);
    if (dto.courseName !== undefined) update.courseName = this.optionalTrim(dto.courseName);
    if (dto.year !== undefined) {
      const dates = this.yearDates(dto.year);
      update.year = dto.year;
      update.startDate = dates.startDate;
      update.endDate = dates.endDate;
    }
    if (dto.maxCapacity !== undefined) {
      const enrolledCount = await this.currentEnrolledCount(id);
      if (dto.maxCapacity < enrolledCount) {
        throw new BadRequestException('Max capacity cannot be less than enrolled student count.');
      }
      update.maxCapacity = dto.maxCapacity;
    }

    return this.withTransaction(async (session) => {
      if (Object.keys(update).length) {
        await this.batches.updateOne({ _id: id, teacherId, deletedAt: { $exists: false } }, { $set: update }, { session });
      }
      if (schedule) {
        await this.schedules.deleteMany({ batchId: id }, { session });
        await this.schedules.insertMany(
          schedule.map((item) => ({ batchId: id, dayOfWeek: item.dayOfWeek, startTime: item.startTime })),
          { session }
        );
      }
      return this.findOne(teacherId, id, session);
    });
  }

  async updateStatus(teacherId: string, id: string, status: BatchStatus): Promise<Record<string, unknown>> {
    const batch = await this.batches.findOneAndUpdate(
      { _id: id, teacherId, deletedAt: { $exists: false } },
      { $set: { status } },
      { new: true }
    );
    if (!batch) throw new NotFoundException('Batch not found');
    const schedules = await this.schedules.find({ batchId: id }).sort({ dayOfWeek: 1 });
    return this.serialize(batch, schedules);
  }

  async remove(teacherId: string, id: string): Promise<void> {
    const batch = await this.batches.findOneAndUpdate(
      { _id: id, teacherId, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), status: 'CANCELLED' } },
      { new: true }
    );
    if (!batch) throw new NotFoundException('Batch not found');
  }

  private async findOwnedBatch(teacherId: string, id: string, session?: ClientSession): Promise<BatchMongoDocument> {
    const batch = await this.batches.findOne({ _id: id, teacherId, deletedAt: { $exists: false } }).session(session ?? null);
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  private async findOwnedWithSchedules(teacherId: string, id: string, session?: ClientSession): Promise<BatchWithSchedules> {
    const batch = await this.findOwnedBatch(teacherId, id, session);
    const schedules = await this.schedules.find({ batchId: id }).sort({ dayOfWeek: 1 }).session(session ?? null);
    return { batch, schedules };
  }

  private async assertUniqueBatch(teacherId: string, name: string, year: number, excludeId?: string): Promise<void> {
    const filter: Record<string, unknown> = {
      teacherId,
      name: name.trim(),
      year,
      deletedAt: { $exists: false }
    };
    if (excludeId) filter._id = { $ne: excludeId };
    if (await this.batches.exists(filter)) {
      throw new ConflictException('A batch with this name already exists for the selected year.');
    }
  }

  private normalizeSchedule(schedule: BatchScheduleDto[]): BatchScheduleDto[] {
    const seen = new Set<BatchWeekday>();
    return schedule.map((item) => {
      if (!item.startTime) {
        throw new BadRequestException('Every selected weekday must include a start time.');
      }
      if (seen.has(item.dayOfWeek)) {
        throw new BadRequestException('Duplicate weekdays are not allowed in the same batch.');
      }
      seen.add(item.dayOfWeek);
      return { dayOfWeek: item.dayOfWeek, startTime: item.startTime };
    });
  }

  private async scheduleMap(batchIds: string[]): Promise<Map<string, BatchScheduleMongoDocument[]>> {
    if (!batchIds.length) return new Map();
    const schedules = await this.schedules.find({ batchId: { $in: batchIds } }).sort({ dayOfWeek: 1 });
    return schedules.reduce((map, schedule) => {
      const list = map.get(schedule.batchId) ?? [];
      list.push(schedule);
      map.set(schedule.batchId, list);
      return map;
    }, new Map<string, BatchScheduleMongoDocument[]>());
  }

  private serialize(batch: BatchMongoDocument, schedules: BatchScheduleMongoDocument[]): Record<string, unknown> {
    return {
      id: batch.id,
      name: batch.name,
      courseId: batch.courseId,
      courseName: batch.courseName,
      teacherId: batch.teacherId,
      year: batch.year,
      startDate: this.dateOnly(batch.startDate),
      endDate: this.dateOnly(batch.endDate),
      maxCapacity: batch.maxCapacity,
      enrolledCount: 0,
      status: batch.status,
      schedule: schedules.map((schedule) => ({
        id: schedule.id,
        dayOfWeek: schedule.dayOfWeek,
        startTime: schedule.startTime
      })),
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt
    };
  }

  private async withTransaction<T>(work: (session?: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(() => work(session));
    } catch (error) {
      if (this.isStandaloneTransactionError(error)) {
        return work();
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  private isStandaloneTransactionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    return message.includes('Transaction numbers are only allowed') || message.includes('replica set member or mongos');
  }

  private yearDates(year: number): { startDate: Date; endDate: Date } {
    return {
      startDate: new Date(Date.UTC(year, 0, 1)),
      endDate: new Date(Date.UTC(year, 11, 31))
    };
  }

  private dateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private optionalTrim(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  private async currentEnrolledCount(_batchId: string): Promise<number> {
    return 0;
  }
}
