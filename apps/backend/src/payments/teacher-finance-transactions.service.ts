import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model } from 'mongoose';
import { TeacherBalanceLockDocument } from './payment.schemas';

/** A transactional row lock serializes booking credits/refunds and payout reservations across nodes. */
@Injectable()
export class TeacherFinanceTransactions {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(TeacherBalanceLockDocument.name) private readonly locks: Model<TeacherBalanceLockDocument>,
  ) {}

  async lock(teacherId: string, session: ClientSession): Promise<void> {
    await this.locks.updateOne({ _id: teacherId }, { $inc: { revision: 1 } }, { upsert: true, session }).exec();
  }

  async run<T>(teacherId: string, work: (session: ClientSession) => Promise<T>): Promise<T> {
    try { await this.locks.updateOne({ _id: teacherId }, { $setOnInsert: { revision: 0 } }, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    return this.connection.transaction(async session => {
      await this.lock(teacherId, session);
      return work(session);
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  }
}
